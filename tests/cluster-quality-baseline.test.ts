import test from "node:test"
import assert from "node:assert/strict"

import {
  MIXED_CLUSTER_THRESHOLD,
  baselineToCsvRow,
  summarizeClusterQuality,
  type ClusterQualityRow,
} from "../lib/cluster-quality/baseline-metrics.ts"

// Helpers: build rows tersely with sensible defaults.
function singleton(overrides: Partial<ClusterQualityRow> = {}): ClusterQualityRow {
  return {
    cluster_id: overrides.cluster_id ?? `c-${Math.random()}`,
    cluster_key: overrides.cluster_key ?? "title:abc",
    size_in_window: 1,
    ...overrides,
  }
}

function multi(overrides: Partial<ClusterQualityRow> = {}): ClusterQualityRow {
  return {
    cluster_id: overrides.cluster_id ?? `c-${Math.random()}`,
    cluster_key: overrides.cluster_key ?? "semantic:def",
    size_in_window: 5,
    ...overrides,
  }
}

// ============================================================================
// Threshold contract — locked in plan + code
// ============================================================================

test("MIXED_CLUSTER_THRESHOLD is exactly 0.5 — Phase 6 / Phase 11 rely on this value", () => {
  // If this assertion fails, the plan doc and the success thresholds
  // are out of sync. Updating the threshold without updating the doc
  // breaks the Phase 6 win/no-regress contract.
  assert.equal(MIXED_CLUSTER_THRESHOLD, 0.5)
})

// ============================================================================
// Primary KPI: singleton_rate
// ============================================================================

test("singleton_rate: all singletons → 1.0", () => {
  const result = summarizeClusterQuality([singleton(), singleton(), singleton()])
  assert.equal(result.singleton_rate, 1)
  assert.equal(result.percentages.singleton_pct, 1)
})

test("singleton_rate: mix of singleton + multi → exact ratio", () => {
  const result = summarizeClusterQuality([singleton(), singleton(), multi(), multi()])
  assert.equal(result.singleton_rate, 0.5)
})

test("singleton_rate: empty input → null (avoid divide-by-zero)", () => {
  const result = summarizeClusterQuality([])
  assert.equal(result.singleton_rate, null)
  assert.equal(result.percentages.singleton_pct, null)
})

test("singleton_rate counts size_in_window <= 1; cluster with size 0 also counts as singleton", () => {
  const result = summarizeClusterQuality([
    singleton({ size_in_window: 0 }),
    singleton({ size_in_window: 1 }),
    multi({ size_in_window: 2 }),
  ])
  assert.equal(result.singleton_clusters, 2)
  assert.equal(result.multi_member_clusters, 1)
})

// ============================================================================
// Primary KPI: coherent_cluster_rate
// ============================================================================

test("coherent_cluster_rate: only counts clusters with family classification or review", () => {
  // 3 classified, 2 with reviews only, 1 with nothing
  const result = summarizeClusterQuality([
    multi({ family_kind: "coherent_single_issue" }),
    multi({ family_kind: "mixed_multi_causal" }),
    multi({ family_kind: "low_evidence" }),
    multi({ has_family_review: true }), // has review but no family_kind
    multi({ has_family_review: true }), // has review but no family_kind
    multi({}), // nothing
  ])
  // Numerator: 1 (only "coherent_single_issue")
  // Denominator: 5 (3 classified + 2 reviewed; the bare cluster is excluded)
  assert.equal(result.coherent_cluster_rate, 0.2)
  assert.equal(result.family_classified_count, 5)
})

test("coherent_cluster_rate: empty classified set → null", () => {
  const result = summarizeClusterQuality([
    multi({}), // no family kind, no review
    singleton({}),
  ])
  assert.equal(result.coherent_cluster_rate, null)
  assert.equal(result.family_classified_count, 0)
})

test("split_needed_family_rate counts only mixed_multi_causal", () => {
  const result = summarizeClusterQuality([
    multi({ family_kind: "coherent_single_issue" }),
    multi({ family_kind: "mixed_multi_causal" }),
    multi({ family_kind: "mixed_multi_causal" }),
    multi({ family_kind: "low_evidence" }),
  ])
  assert.equal(result.split_needed_family_rate, 0.5)
})

// ============================================================================
// Primary KPI: mixed_cluster_rate
// ============================================================================

test("mixed_cluster_rate: dominant share at exactly 0.5 is NOT mixed (>=-semantics)", () => {
  // Boundary case: a value at exactly threshold (0.5) means dominant
  // share AT threshold, not below — the < 0.5 case is mixed.
  const result = summarizeClusterQuality([
    multi({ dominant_llm_category: "bug", dominant_llm_category_share: 0.5 }),
    multi({ dominant_llm_category: "bug", dominant_llm_category_share: 0.49 }),
  ])
  // Only the 0.49 one is mixed
  assert.equal(result.mixed_category_clusters, 1)
  assert.equal(result.mixed_cluster_rate, 0.5)
})

test("mixed_cluster_rate excludes singletons and unclassified clusters from denominator", () => {
  const result = summarizeClusterQuality([
    multi({ dominant_llm_category: "a", dominant_llm_category_share: 0.4 }), // mixed
    multi({ dominant_llm_category: "b", dominant_llm_category_share: 0.9 }), // not mixed
    multi({}),                                                                 // not classified — excluded
    singleton({ dominant_llm_category: "c", dominant_llm_category_share: 1.0 }), // singleton — excluded
  ])
  // Denominator = 2 (only the two multi-member CLASSIFIED clusters)
  // Numerator = 1
  assert.equal(result.mixed_cluster_rate, 0.5)
})

test("mixed_cluster_rate: empty multi-member-classified set → null (not 0)", () => {
  const result = summarizeClusterQuality([singleton(), singleton(), multi({})])
  assert.equal(result.mixed_cluster_rate, null)
})

// ============================================================================
// Bucketing distributions
// ============================================================================

test("dominant_category_share_distribution: known share placement at boundaries", () => {
  const result = summarizeClusterQuality([
    multi({ dominant_llm_category: "a", dominant_llm_category_share: 0.0 }),    // <0.50
    multi({ dominant_llm_category: "a", dominant_llm_category_share: 0.49 }),   // <0.50
    multi({ dominant_llm_category: "a", dominant_llm_category_share: 0.5 }),    // 0.50 bucket
    multi({ dominant_llm_category: "a", dominant_llm_category_share: 0.69 }),   // 0.50 bucket
    multi({ dominant_llm_category: "a", dominant_llm_category_share: 0.7 }),    // 0.70 bucket
    multi({ dominant_llm_category: "a", dominant_llm_category_share: 0.91 }),   // 0.90 bucket
    multi({ dominant_llm_category: "a", dominant_llm_category_share: 1.0 }),    // 0.90 bucket
  ])
  const dist = result.dominant_category_share_distribution
  assert.equal(dist["0.00"], 2)
  assert.equal(dist["0.50"], 2)
  assert.equal(dist["0.70"], 1)
  assert.equal(dist["0.90"], 2)
})

// ============================================================================
// Cluster-key prefix counts
// ============================================================================

test("semantic vs fallback prefix counts", () => {
  const result = summarizeClusterQuality([
    multi({ cluster_key: "semantic:abc" }),
    multi({ cluster_key: "semantic:def" }),
    multi({ cluster_key: "title:ghi" }),
    multi({ cluster_key: "weird:xyz" }), // unknown prefix — neither bucket
  ])
  assert.equal(result.semantic_clusters, 2)
  assert.equal(result.deterministic_fallback_clusters, 1)
  // Total still 4 — "other" prefix doesn't disappear, just isn't bucketed
  assert.equal(result.total_clusters, 4)
})

// ============================================================================
// Cross-axis breakdowns
// ============================================================================

test("singleton_rate_by_category: per-Topic singleton ratio", () => {
  const result = summarizeClusterQuality([
    singleton({ dominant_topic_slug: "bug" }),
    singleton({ dominant_topic_slug: "bug" }),
    multi({ dominant_topic_slug: "bug" }),         // 2/3 singletons in "bug" → 0.6667
    singleton({ dominant_topic_slug: "ux-ui" }),
    multi({ dominant_topic_slug: "ux-ui" }),       // 1/3 singletons in "ux-ui" → 0.3333
    multi({ dominant_topic_slug: "ux-ui" }),
  ])
  assert.equal(result.singleton_rate_by_category.bug, 0.6667)
  assert.equal(result.singleton_rate_by_category["ux-ui"], 0.3333)
})

test("singleton_rate_by_category: skips clusters with null Topic slug", () => {
  const result = summarizeClusterQuality([
    singleton({ dominant_topic_slug: null }),
    singleton({ dominant_topic_slug: undefined }),
    singleton({ dominant_topic_slug: "" }),
    singleton({ dominant_topic_slug: "  " }),
    singleton({ dominant_topic_slug: "bug" }),
  ])
  // Only "bug" should appear in the breakdown
  assert.deepEqual(Object.keys(result.singleton_rate_by_category), ["bug"])
})

test("multi_member_clusters_by_category: only counts multi-member rows", () => {
  const result = summarizeClusterQuality([
    multi({ dominant_topic_slug: "bug" }),
    multi({ dominant_topic_slug: "bug" }),
    singleton({ dominant_topic_slug: "bug" }),       // not counted (singleton)
    multi({ dominant_topic_slug: "performance" }),
  ])
  assert.equal(result.multi_member_clusters_by_category.bug, 2)
  assert.equal(result.multi_member_clusters_by_category.performance, 1)
})

// ============================================================================
// Family classification health
// ============================================================================

test("family_classification_coverage = classified / total (active clusters)", () => {
  const result = summarizeClusterQuality([
    multi({ family_kind: "coherent_single_issue" }),
    multi({ family_kind: "low_evidence" }),
    multi({}),
    multi({}),
  ])
  assert.equal(result.family_classification_coverage, 0.5)
  assert.equal(result.family_classified_count, 2)
})

test("review_disagreement_rate: null when no reviews exist; ratio when reviews exist", () => {
  const noReviews = summarizeClusterQuality([
    multi({ family_kind: "coherent_single_issue" }),
  ])
  assert.equal(noReviews.review_disagreement_rate, null)

  const withReviews = summarizeClusterQuality([
    multi({ has_family_review: true, review_disagreement: false }),
    multi({ has_family_review: true, review_disagreement: false }),
    multi({ has_family_review: true, review_disagreement: true }),
    multi({}), // no review at all
  ])
  // 1 disagreement out of 3 reviewed clusters
  assert.equal(withReviews.review_disagreement_rate, 0.3333)
})

// ============================================================================
// Top-N for unbounded distributions
// ============================================================================

test("singleton_rate_by_category truncates to top 20 with _other tail", () => {
  // 25 distinct topics; default K=20.
  const rows: ClusterQualityRow[] = Array.from({ length: 25 }, (_, i) =>
    singleton({ dominant_topic_slug: `topic_${String(i).padStart(2, "0")}` }),
  )
  const result = summarizeClusterQuality(rows)
  const keys = Object.keys(result.singleton_rate_by_category)
  // 20 head + 1 _other = 21
  assert.equal(keys.length, 21)
  assert.ok(keys.includes("_other"))
})

// ============================================================================
// Mixed-topic surface
// ============================================================================

test("top_mixed_topic_clusters: limited to 10, sorted desc by score, multi-member only", () => {
  const rows: ClusterQualityRow[] = [
    ...Array.from({ length: 15 }, (_, i) => multi({
      cluster_id: `c-${i}`,
      mixed_topic_score: i / 100, // 0.00, 0.01, 0.02, ..., 0.14
    })),
    // A singleton with a high score — should NOT appear (singletons can't be "mixed")
    singleton({ cluster_id: "s-1", mixed_topic_score: 0.99 }),
  ]
  const result = summarizeClusterQuality(rows)
  assert.equal(result.top_mixed_topic_clusters.length, 10)
  // Highest-scoring 10 of the multi-member set should be 0.05..0.14
  assert.equal(result.top_mixed_topic_clusters[0].mixed_topic_score, 0.14)
  assert.equal(result.top_mixed_topic_clusters[9].mixed_topic_score, 0.05)
  // Singleton excluded
  assert.ok(!result.top_mixed_topic_clusters.some((c) => c.cluster_id === "s-1"))
})

// ============================================================================
// Aggregate sanity invariants
// ============================================================================

test("counts add up: singleton_clusters + multi_member_clusters <= total_clusters", () => {
  // <= because cluster_key with size 0 is technically singleton-counted
  // here, but a cluster with negative size (corrupted data) shouldn't
  // be either — we don't model that case but the invariant should
  // hold either way.
  const result = summarizeClusterQuality([
    singleton(),
    multi(),
    multi(),
  ])
  assert.ok(result.singleton_clusters + result.multi_member_clusters <= result.total_clusters)
  assert.equal(result.singleton_clusters, 1)
  assert.equal(result.multi_member_clusters, 2)
})

test("percentages mirror the rate fields exactly", () => {
  // The percentages block exists for snapshot ergonomics — every value
  // MUST match the corresponding rate field. Drift between the two
  // means a future operator pasting one set into the doc gets a
  // different number than another pasting the other set.
  const result = summarizeClusterQuality([
    singleton({ family_kind: "coherent_single_issue" }),
    multi({ family_kind: "coherent_single_issue", dominant_llm_category: "a", dominant_llm_category_share: 0.4 }),
    multi({ family_kind: "low_evidence", dominant_llm_category: "b", dominant_llm_category_share: 0.9 }),
  ])
  assert.equal(result.percentages.singleton_pct, result.singleton_rate)
  assert.equal(result.percentages.coherent_cluster_pct, result.coherent_cluster_rate)
  assert.equal(result.percentages.mixed_cluster_pct, result.mixed_cluster_rate)
  assert.equal(result.percentages.family_classification_coverage_pct, result.family_classification_coverage)
})

// ============================================================================
// CSV row helper — for the post-merge baseline snapshot append
// ============================================================================

test("baselineToCsvRow renders null as em-dash; percentages as XX.X%", () => {
  const baseline = summarizeClusterQuality([
    singleton(),
    multi({ family_kind: "coherent_single_issue", dominant_llm_category: "bug", dominant_llm_category_share: 0.9 }),
  ])
  const csv = baselineToCsvRow("2026-05-01", baseline)
  // Date, total, singleton%, coherent%, mixed%, family_cov%, semantic%, fallback%
  assert.match(csv, /^2026-05-01,2,/)
  // singleton_rate = 1/2 = 0.50 → "50.0%"
  assert.match(csv, /,50\.0%,/)
})

test("baselineToCsvRow handles all-null gracefully", () => {
  const baseline = summarizeClusterQuality([])
  const csv = baselineToCsvRow("2026-05-01", baseline)
  // total_clusters is 0; all rates are null → em-dash
  assert.equal(csv, "2026-05-01,0,—,—,—,—,—,—")
})
