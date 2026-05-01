/**
 * Phase 3 cluster-quality baseline aggregator.
 *
 * Pure (no DB / network / React) so node:test can exercise the contract
 * directly. The route handler at app/api/admin/cluster-quality/route.ts
 * is responsible for materializing ClusterQualityRow from the live
 * schema; everything below operates on already-collected rows.
 *
 * Contract source of truth: docs/CLASSIFICATION_EVOLUTION_PLAN.md §3.
 * If a definition changes, update both this module's tests AND the doc
 * — the two MUST agree because Phase 6 / Phase 11 read the doc to
 * decide success thresholds.
 */

/** Mixed-cluster threshold: a multi-member classified cluster is
 *  "mixed" when its dominant LLM-category share falls below this value.
 *  Centralized so a future re-tune happens in one place. */
export const MIXED_CLUSTER_THRESHOLD = 0.5

/** Top-K for unbounded distribution maps. Same constant Phase 2 uses;
 *  documented inline because category/subcategory strings have a long
 *  tail of typo / casing / hallucination variations that bloat the
 *  response without adding decision signal. */
const TOP_K_DISTRIBUTION = 20

/** Histogram boundaries for `dominant_category_share_distribution`.
 *  Matches the proposed mixed-cluster threshold (0.5) so the leftmost
 *  bucket = "mixed" by definition. */
const SHARE_BUCKETS = [0.0, 0.5, 0.7, 0.9] as const

/** Per-cluster row consumed by `summarizeClusterQuality`. The route
 *  is responsible for joining the four upstream sources and producing
 *  this shape:
 *
 *    - clusters / cluster_members → cluster_id, cluster_key, size_in_window
 *    - mv_cluster_health_current → dominant_error_code_share
 *    - family_classification_current → family_kind, has_family_review
 *    - mv_cluster_topic_metadata → dominant_topic_slug, mixed_topic_score
 *    - classifications (per cluster_member) → dominant LLM category /
 *      subcategory aggregated to cluster level
 *
 *  Documenting the upstream sources here is what prevents the next
 *  caller from drifting the schema (the lesson from PR #186's wrong-
 *  column `family_kind` bug). */
export interface ClusterQualityRow {
  cluster_id: string
  /** "semantic:<hash>" for embedding-based clusters; "title:<md5>" for
   *  the deterministic title-hash fallback. Anything else counts as
   *  "other" and surfaces a warning in the UI. */
  cluster_key: string
  /** Active member count. Singleton = 1, multi-member = >= 2. Clusters
   *  with all members detached should NOT appear in the input set
   *  (route filters them out — see `cluster_members WHERE detached_at
   *  IS NULL`). */
  size_in_window: number
  /** Heuristic Topic slug from `mv_cluster_topic_metadata.dominant_topic_slug`.
   *  Null when the cluster has no classified members. */
  dominant_topic_slug?: string | null
  /** mv_cluster_topic_metadata.mixed_topic_score (numeric 0..1).
   *  Higher = more topic spread. Null when not computed. */
  mixed_topic_score?: number | null
  /** Top LLM category across cluster members and its share. Null when
   *  the cluster has no classified members. */
  dominant_llm_category?: string | null
  dominant_llm_category_share?: number | null
  /** Top LLM subcategory across cluster members and its share. Null
   *  when no classified members. */
  dominant_llm_subcategory?: string | null
  dominant_llm_subcategory_share?: number | null
  /** family_classification_current.family_kind. Possible values seen
   *  in production: "coherent_single_issue", "mixed_multi_causal",
   *  "low_evidence". Null when no family-classification row exists. */
  family_kind?: string | null
  /** Whether the cluster has a row in family_classification_review_current.
   *  Used for the `coherent_cluster_rate` denominator (clusters with
   *  family classification OR review). */
  has_family_review?: boolean | null
  /** Reviewer's disagreement signal: true when
   *  family_classification_review_current.actual_family_kind differs
   *  from the LLM-assigned family_kind. Null when no review exists. */
  review_disagreement?: boolean | null
}

export interface ClusterQualityBaseline {
  // ---- Primary KPIs (Phase 6 / Phase 11 read these) ----
  /** clusters with family_kind = "coherent_single_issue" / clusters
   *  with family_classification or review. Null when denominator is 0. */
  coherent_cluster_rate: number | null
  /** active clusters with size_in_window = 1 / total active clusters.
   *  Null only when there are zero clusters. */
  singleton_rate: number | null
  /** multi-member classified clusters where dominant LLM-category
   *  share < MIXED_CLUSTER_THRESHOLD / multi-member classified
   *  clusters. Null when denominator is 0. */
  mixed_cluster_rate: number | null

  // ---- Diagnostic counts ----
  total_clusters: number
  semantic_clusters: number
  deterministic_fallback_clusters: number
  multi_member_clusters: number
  singleton_clusters: number

  // ---- Cross-axis breakdowns ----
  /** Map: heuristic Topic slug → singleton rate within that topic. */
  singleton_rate_by_category: Record<string, number>
  /** Map: heuristic Topic slug → number of multi-member clusters. */
  multi_member_clusters_by_category: Record<string, number>
  /** Map: LLM subcategory → singleton rate within that subcategory. */
  singleton_rate_by_subcategory: Record<string, number>
  multi_member_clusters_by_subcategory: Record<string, number>

  // ---- Dominant-share distribution over multi-member classified clusters ----
  /** Histogram of dominant_llm_category_share for multi-member
   *  classified clusters. Buckets: <0.50, 0.50-0.70, 0.70-0.90,
   *  0.90-1.00. The <0.50 bucket = mixed. */
  dominant_category_share_distribution: Record<string, number>
  mixed_category_clusters: number
  mixed_subcategory_clusters: number

  // ---- Family classification health ----
  family_classification_coverage: number | null
  family_classified_count: number
  coherent_family_rate: number | null
  split_needed_family_rate: number | null
  /** Null when no reviewed clusters exist. */
  review_disagreement_rate: number | null

  // ---- Mixed-topic helpers (already on mv_cluster_topic_metadata) ----
  /** Top-N clusters by mixed_topic_score, surfaced for the UI's
   *  "over-merged" drill-down. */
  top_mixed_topic_clusters: Array<{ cluster_id: string; mixed_topic_score: number }>

  // ---- Decision-gate-friendly percentages ----
  /** Same numeric values as the rates above, expressed as 0..1 with
   *  4-decimal precision. Operators reading the JSON pull these
   *  directly into a doc snapshot — no manual computation. */
  percentages: {
    coherent_cluster_pct: number | null
    singleton_pct: number | null
    mixed_cluster_pct: number | null
    family_classification_coverage_pct: number | null
    semantic_share_pct: number | null
    fallback_share_pct: number | null
  }
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Number((numerator / denominator).toFixed(4))
}

function topN(d: Record<string, number>, n = TOP_K_DISTRIBUTION): Record<string, number> {
  const entries = Object.entries(d).sort((a, b) => b[1] - a[1])
  const head = entries.slice(0, n)
  const tail = entries.slice(n)
  const tailSum = tail.reduce((s, [, v]) => s + v, 0)
  const out: Record<string, number> = Object.fromEntries(head)
  if (tailSum > 0) out._other = tailSum
  return out
}

/** Bucket a share into one of the histogram bins. Uses ≥-semantics
 *  (a value at exactly 0.5 lands in the 0.5 bucket, not the 0.0 one).
 *  This MUST match the mixed-cluster threshold semantics: the < 0.5
 *  case is the mixed bucket. */
function shareBucketKey(share: number): string {
  for (let i = SHARE_BUCKETS.length - 1; i >= 0; i--) {
    if (share >= SHARE_BUCKETS[i]) return SHARE_BUCKETS[i].toFixed(2)
  }
  return SHARE_BUCKETS[0].toFixed(2)
}

/** Convert a per-key {singletons, total} count map into a per-key
 *  rate map. Used for `singleton_rate_by_category` and `_by_subcategory`.
 *  Skips entries with zero total to avoid divide-by-zero. */
function toRateMap(counts: Map<string, { singletons: number; total: number }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, { singletons, total }] of counts) {
    if (total > 0) out[key] = Number((singletons / total).toFixed(4))
  }
  return out
}

export function summarizeClusterQuality(rows: ClusterQualityRow[]): ClusterQualityBaseline {
  const total_clusters = rows.length

  // Bucket counters
  let semantic_clusters = 0
  let deterministic_fallback_clusters = 0
  let multi_member_clusters = 0
  let singleton_clusters = 0
  let family_classified_count = 0
  let coherent_count = 0
  let split_needed_count = 0
  let mixed_category_clusters = 0
  let mixed_subcategory_clusters = 0
  let multi_member_classified = 0
  let reviewed_count = 0
  let review_disagreement_count = 0

  // Cross-axis maps
  const singletonByCategory = new Map<string, { singletons: number; total: number }>()
  const singletonBySubcategory = new Map<string, { singletons: number; total: number }>()
  const multiByCategory = new Map<string, number>()
  const multiBySubcategory = new Map<string, number>()

  // Distribution histogram (multi-member classified only)
  const shareDist: Record<string, number> = {}
  for (const lo of SHARE_BUCKETS) shareDist[lo.toFixed(2)] = 0

  // Mixed-topic surface (for UI drill-down)
  const mixedTopicCandidates: Array<{ cluster_id: string; mixed_topic_score: number }> = []

  for (const row of rows) {
    const isSingleton = row.size_in_window <= 1
    const isMulti = row.size_in_window >= 2

    if (isSingleton) singleton_clusters++
    if (isMulti) multi_member_clusters++

    if (row.cluster_key.startsWith("semantic:")) semantic_clusters++
    else if (row.cluster_key.startsWith("title:")) deterministic_fallback_clusters++

    // Family classification gating
    const hasFamilyAssignment = Boolean(row.family_kind) || row.has_family_review === true
    if (hasFamilyAssignment) family_classified_count++
    if (row.family_kind === "coherent_single_issue") coherent_count++
    if (row.family_kind === "mixed_multi_causal") split_needed_count++

    if (row.has_family_review) {
      reviewed_count++
      if (row.review_disagreement === true) review_disagreement_count++
    }

    // Cross-axis breakdowns by Topic and LLM subcategory
    const topicKey = row.dominant_topic_slug?.trim()
    if (topicKey) {
      const cur = singletonByCategory.get(topicKey) ?? { singletons: 0, total: 0 }
      cur.total++
      if (isSingleton) cur.singletons++
      singletonByCategory.set(topicKey, cur)
      if (isMulti) multiByCategory.set(topicKey, (multiByCategory.get(topicKey) ?? 0) + 1)
    }
    const subcategoryKey = row.dominant_llm_subcategory?.trim()
    if (subcategoryKey) {
      const cur = singletonBySubcategory.get(subcategoryKey) ?? { singletons: 0, total: 0 }
      cur.total++
      if (isSingleton) cur.singletons++
      singletonBySubcategory.set(subcategoryKey, cur)
      if (isMulti) multiBySubcategory.set(subcategoryKey, (multiBySubcategory.get(subcategoryKey) ?? 0) + 1)
    }

    // Mixed-cluster + share-distribution: multi-member classified only.
    // A singleton can't be "mixed" by definition; an unclassified
    // cluster can't be evaluated. Reporting either of these in the
    // mixed-cluster denominator would conflate two different concerns.
    if (isMulti && typeof row.dominant_llm_category_share === "number") {
      multi_member_classified++
      shareDist[shareBucketKey(row.dominant_llm_category_share)]++
      if (row.dominant_llm_category_share < MIXED_CLUSTER_THRESHOLD) mixed_category_clusters++
    }
    if (
      isMulti &&
      typeof row.dominant_llm_subcategory_share === "number" &&
      row.dominant_llm_subcategory_share < MIXED_CLUSTER_THRESHOLD
    ) {
      mixed_subcategory_clusters++
    }

    if (typeof row.mixed_topic_score === "number" && isMulti) {
      mixedTopicCandidates.push({ cluster_id: row.cluster_id, mixed_topic_score: row.mixed_topic_score })
    }
  }

  // Top-N mixed-topic clusters for the UI drill-down. Sorted by score desc.
  mixedTopicCandidates.sort((a, b) => b.mixed_topic_score - a.mixed_topic_score)
  const top_mixed_topic_clusters = mixedTopicCandidates.slice(0, 10)

  return {
    coherent_cluster_rate: ratio(coherent_count, family_classified_count),
    singleton_rate: ratio(singleton_clusters, total_clusters),
    mixed_cluster_rate: ratio(mixed_category_clusters, multi_member_classified),

    total_clusters,
    semantic_clusters,
    deterministic_fallback_clusters,
    multi_member_clusters,
    singleton_clusters,

    singleton_rate_by_category: topN(toRateMap(singletonByCategory)),
    multi_member_clusters_by_category: topN(Object.fromEntries(multiByCategory)),
    singleton_rate_by_subcategory: topN(toRateMap(singletonBySubcategory)),
    multi_member_clusters_by_subcategory: topN(Object.fromEntries(multiBySubcategory)),

    dominant_category_share_distribution: shareDist,
    mixed_category_clusters,
    mixed_subcategory_clusters,

    family_classification_coverage: ratio(family_classified_count, total_clusters),
    family_classified_count,
    coherent_family_rate: ratio(coherent_count, family_classified_count),
    split_needed_family_rate: ratio(split_needed_count, family_classified_count),
    review_disagreement_rate: reviewed_count > 0 ? ratio(review_disagreement_count, reviewed_count) : null,

    top_mixed_topic_clusters,

    percentages: {
      coherent_cluster_pct: ratio(coherent_count, family_classified_count),
      singleton_pct: ratio(singleton_clusters, total_clusters),
      mixed_cluster_pct: ratio(mixed_category_clusters, multi_member_classified),
      family_classification_coverage_pct: ratio(family_classified_count, total_clusters),
      semantic_share_pct: ratio(semantic_clusters, total_clusters),
      fallback_share_pct: ratio(deterministic_fallback_clusters, total_clusters),
    },
  }
}

/** Render a baseline as a CSV row suitable for appending to the
 *  `Phase 3 baseline snapshot` table in CLASSIFICATION_EVOLUTION_PLAN.md.
 *  The route's `?format=csv` handler returns this directly. Operators
 *  paste it under the table header, no manual transformation needed. */
export function baselineToCsvRow(date: string, b: ClusterQualityBaseline): string {
  const fmt = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`)
  return [
    date,
    String(b.total_clusters),
    fmt(b.singleton_rate),
    fmt(b.coherent_cluster_rate),
    fmt(b.mixed_cluster_rate),
    fmt(b.family_classification_coverage),
    fmt(b.percentages.semantic_share_pct),
    fmt(b.percentages.fallback_share_pct),
  ].join(",")
}
