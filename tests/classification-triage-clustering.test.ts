import test from "node:test"
import assert from "node:assert/strict"

// Pure-function characterization of the semantic-cluster grouping memo and
// the compound-filter (triage group × semantic cluster) logic added to
// components/dashboard/classification-triage.tsx.
//
// See docs/ARCHITECTURE.md §3.2 (aggregation layer: clusters) and §5.3
// (triage UI). These tests lock the behavior documented there:
//   - Records without a cluster_id are invisible to the semantic-cluster
//     chip strip (no cluster means no grouping to surface).
//   - Chip ordering is total-in-scope descending, capped at the top 10.
//   - The group filter and the semantic-cluster filter compose with AND
//     semantics, not OR — users can narrow along both axes simultaneously.
//   - "All" on either axis is an identity filter on that axis.

interface MinimalRecord {
  id: string
  effective_category: string
  subcategory: string | null
  cluster_id: string | null
  cluster_key: string | null
  cluster_label: string | null
  cluster_label_confidence: number | null
  cluster_size: number | null
}

// Mirrors the `semanticClusters` memo in classification-triage.tsx.
// Records without a cluster_id are skipped so the chip strip only shows
// actionable clusters. Label/size are captured from the first record seen
// for each cluster_id — callers rely on the API returning identical
// cluster metadata for every record that shares a cluster_id.
//
// Deterministic title-hash fallback clusters (`title:<md5>`) are filtered
// out unless they have ≥2 members — a `title:` singleton carries no more
// information than the existing group-by and would render as meaningless
// "Unlabelled cluster · 1 obs" noise (data-scientist review H2).
function computeSemanticClusters(records: MinimalRecord[]) {
  type Bucket = {
    id: string
    key: string | null
    label: string | null
    label_confidence: number | null
    size: number
    total: number
  }
  const grouped = new Map<string, Bucket>()
  for (const record of records) {
    if (!record.cluster_id) continue
    const current = grouped.get(record.cluster_id) ?? {
      id: record.cluster_id,
      key: record.cluster_key,
      label: record.cluster_label,
      label_confidence: record.cluster_label_confidence,
      size: record.cluster_size ?? 0,
      total: 0,
    }
    current.total += 1
    grouped.set(record.cluster_id, current)
  }
  return Array.from(grouped.values())
    .filter((c) => (c.key?.startsWith("semantic:") ?? false) || c.size >= 2)
    .sort((a, b) => b.total - a.total || b.size - a.size)
    .slice(0, 10)
}

// Mirrors the confidence-gating helpers that decide whether to trust a
// model-generated cluster label at display time. See
// classification-triage.tsx (data-scientist review M1).
const LABEL_CONFIDENCE_SHOW_THRESHOLD = 0.6
const LABEL_CONFIDENCE_HIGH_THRESHOLD = 0.8

function hasTrustedLabel(label: string | null, confidence: number | null): boolean {
  return label !== null && confidence !== null && confidence >= LABEL_CONFIDENCE_SHOW_THRESHOLD
}

function bucketConfidence(confidence: number): "High" | "Medium" {
  return confidence >= LABEL_CONFIDENCE_HIGH_THRESHOLD ? "High" : "Medium"
}

// Mirrors the `triageRecords` memo in classification-triage.tsx — the
// compound filter that narrows by both the triage group and the semantic
// cluster at once.
function applyCompoundFilter(
  records: MinimalRecord[],
  groupFilter: string,
  semanticClusterFilter: string,
): MinimalRecord[] {
  return records.filter((record) => {
    const groupMatch =
      groupFilter === "all" ||
      `${record.effective_category} › ${record.subcategory || "General"}` === groupFilter
    const semanticMatch =
      semanticClusterFilter === "all" || record.cluster_id === semanticClusterFilter
    return groupMatch && semanticMatch
  })
}

const mkRecord = (partial: Partial<MinimalRecord>): MinimalRecord => ({
  id: "r",
  effective_category: "bug",
  subcategory: "general",
  cluster_id: null,
  cluster_key: null,
  cluster_label: null,
  cluster_label_confidence: null,
  cluster_size: null,
  ...partial,
})

// Convenience: make a record that belongs to a real (semantic) cluster,
// so the default case doesn't need seven explicit cluster_* overrides.
const mkClustered = (
  id: string,
  overrides: Partial<MinimalRecord> = {},
): MinimalRecord =>
  mkRecord({
    id,
    cluster_id: overrides.cluster_id ?? "c-default",
    cluster_key:
      overrides.cluster_key ??
      `semantic:${overrides.cluster_id ?? "c-default"}`,
    cluster_size: overrides.cluster_size ?? 2,
    ...overrides,
  })

// --- semanticClusters memo ---------------------------------------------------

test("semanticClusters skips records that have no cluster membership", () => {
  // Observations without a cluster_id haven't been through the clustering
  // pipeline yet (or fell below the similarity threshold). Surfacing them
  // would show meaningless empty chips.
  const records = [
    mkRecord({ id: "1", cluster_id: null }),
    mkRecord({ id: "2", cluster_id: null }),
  ]
  const result = computeSemanticClusters(records)
  assert.deepEqual(result, [])
})

test("semanticClusters groups by cluster_id and counts in-scope records", () => {
  const records = [
    mkClustered("1", { cluster_id: "c1", cluster_label: "Repo scan hangs", cluster_size: 7 }),
    mkClustered("2", { cluster_id: "c1", cluster_label: "Repo scan hangs", cluster_size: 7 }),
    mkClustered("3", { cluster_id: "c2", cluster_label: "Auth token expires", cluster_size: 3 }),
  ]
  const result = computeSemanticClusters(records)
  assert.equal(result.length, 2)
  assert.equal(result[0].id, "c1")
  assert.equal(result[0].total, 2)
  assert.equal(result[0].label, "Repo scan hangs")
  assert.equal(result[0].size, 7)
  assert.equal(result[1].id, "c2")
  assert.equal(result[1].total, 1)
})

test("semanticClusters sorts by in-scope total descending, then by total size as tiebreaker", () => {
  // Tiebreaker matters: two clusters with the same in-scope count should
  // not flip order randomly. The larger-total cluster wins the tie so
  // high-impact clusters don't get buried when the reviewer narrows scope.
  const records = [
    mkClustered("1", { cluster_id: "small", cluster_size: 2 }),
    mkClustered("2", { cluster_id: "big", cluster_size: 40 }),
    mkClustered("3", { cluster_id: "big", cluster_size: 40 }),
    mkClustered("4", { cluster_id: "big", cluster_size: 40 }),
    mkClustered("5", { cluster_id: "medium-a", cluster_size: 20 }),
    mkClustered("6", { cluster_id: "medium-a", cluster_size: 20 }),
    mkClustered("7", { cluster_id: "medium-b", cluster_size: 5 }),
    mkClustered("8", { cluster_id: "medium-b", cluster_size: 5 }),
  ]
  const result = computeSemanticClusters(records)
  // big (total=3) first; medium-a and medium-b tie at total=2 — medium-a
  // wins because size 20 > 5; small last.
  assert.deepEqual(
    result.map((c) => c.id),
    ["big", "medium-a", "medium-b", "small"],
  )
})

test("semanticClusters caps at top 10 to keep the chip strip readable", () => {
  const records = Array.from({ length: 15 }, (_, i) =>
    mkClustered(`r${i}`, { cluster_id: `c${i}`, cluster_size: 3 }),
  )
  const result = computeSemanticClusters(records)
  assert.equal(result.length, 10)
})

test("semanticClusters preserves null label when cluster is unlabelled", () => {
  // Labelling can lag behind clustering (or be deleted entirely per the
  // measurable-decision rule in docs/CLUSTERING_DESIGN.md). The UI renders
  // "Unlabelled cluster" — but the memo must pass the null through
  // verbatim, not substitute a string.
  const records = [mkClustered("1", { cluster_id: "c1", cluster_label: null })]
  const result = computeSemanticClusters(records)
  assert.equal(result.length, 1)
  assert.equal(result[0].label, null)
})

test("semanticClusters treats null cluster_size as 0, not undefined", () => {
  const records = [
    mkRecord({
      id: "1",
      cluster_id: "c1",
      cluster_key: "semantic:c1",
      cluster_size: null,
    }),
  ]
  const result = computeSemanticClusters(records)
  assert.equal(result[0].size, 0)
})

// --- title:-prefix fallback filtering (data-scientist review H2) -------------

test("semanticClusters hides title-hash singletons — they carry no information", () => {
  // The deterministic title-hash fallback (`lib/storage/clusters.ts`) fires
  // when embedding/similarity paths can't cluster an observation. It keys
  // on the normalised title MD5 so two distinct reports almost always end
  // up in separate singleton "clusters." Surfacing those as chips next to
  // real semantic clusters would be pure noise.
  const records = [
    mkRecord({
      id: "1",
      cluster_id: "t-1",
      cluster_key: "title:abc123",
      cluster_size: 1,
    }),
  ]
  const result = computeSemanticClusters(records)
  assert.deepEqual(result, [])
})

test("semanticClusters keeps title-hash clusters that accumulated multiple members", () => {
  // If two reports share the exact same normalised title, the title-hash
  // path does produce a real multi-member cluster. That carries useful
  // signal and should be surfaced (no label, but the chip grouping is
  // still meaningful).
  const records = [
    mkRecord({
      id: "1",
      cluster_id: "t-dup",
      cluster_key: "title:ddd",
      cluster_size: 2,
    }),
    mkRecord({
      id: "2",
      cluster_id: "t-dup",
      cluster_key: "title:ddd",
      cluster_size: 2,
    }),
  ]
  const result = computeSemanticClusters(records)
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "t-dup")
  assert.equal(result[0].size, 2)
})

test("semanticClusters keeps real semantic clusters even as singletons (size=1)", () => {
  // A `semantic:` cluster_key means the embedding path actually found a
  // grouping at some point; a size-1 state means members have since been
  // detached. Still meaningful for triage, unlike the title-hash fallback.
  const records = [
    mkClustered("1", { cluster_id: "c-sem", cluster_size: 1 }),
  ]
  const result = computeSemanticClusters(records)
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "c-sem")
})

// --- confidence bucketing (data-scientist review M1) ------------------------

test("hasTrustedLabel hides labels below the show threshold", () => {
  // Raw confidence is self-reported by the labelling model; rendering
  // "confidence 0.45" implies calibrated precision the number does not
  // carry. Below the show threshold (0.6) we render "Unlabelled cluster"
  // instead.
  assert.equal(hasTrustedLabel("a label", 0.59), false)
  assert.equal(hasTrustedLabel("a label", 0.6), true)
  assert.equal(hasTrustedLabel("a label", 0.95), true)
})

test("hasTrustedLabel refuses labels with null confidence", () => {
  // A cluster row with a label but no stored confidence number is
  // untrusted by construction — we can't even say what bucket to show.
  assert.equal(hasTrustedLabel("a label", null), false)
})

test("hasTrustedLabel refuses null labels regardless of confidence", () => {
  assert.equal(hasTrustedLabel(null, 0.95), false)
})

test("bucketConfidence thresholds at 0.8 for High", () => {
  assert.equal(bucketConfidence(0.79), "Medium")
  assert.equal(bucketConfidence(0.8), "High")
  assert.equal(bucketConfidence(0.95), "High")
})

// --- compound filter ---------------------------------------------------------

test("compound filter with both axes on 'all' returns every record unchanged", () => {
  const records = [
    mkRecord({ id: "1", cluster_id: "c1" }),
    mkRecord({ id: "2", cluster_id: null }),
  ]
  const result = applyCompoundFilter(records, "all", "all")
  assert.equal(result.length, 2)
})

test("compound filter with only groupFilter narrows to matching category › subcategory", () => {
  const records = [
    mkRecord({ id: "1", effective_category: "bug", subcategory: "repro", cluster_id: "c1" }),
    mkRecord({ id: "2", effective_category: "bug", subcategory: "flaky", cluster_id: "c1" }),
    mkRecord({ id: "3", effective_category: "ux", subcategory: "color", cluster_id: "c1" }),
  ]
  const result = applyCompoundFilter(records, "bug › repro", "all")
  assert.deepEqual(result.map((r) => r.id), ["1"])
})

test("compound filter with only semanticClusterFilter narrows to matching cluster_id", () => {
  const records = [
    mkRecord({ id: "1", cluster_id: "c1" }),
    mkRecord({ id: "2", cluster_id: "c2" }),
    mkRecord({ id: "3", cluster_id: null }),
  ]
  const result = applyCompoundFilter(records, "all", "c1")
  assert.deepEqual(result.map((r) => r.id), ["1"])
})

test("compound filter composes both axes with AND — intersection, not union", () => {
  // A reviewer who picks "bug › repro" AND the "Repo scan hangs" cluster
  // expects records that match both filters, not either one. Union-style
  // composition would make the filters useless as a narrowing tool.
  const records = [
    mkRecord({ id: "bug-repro-c1", effective_category: "bug", subcategory: "repro", cluster_id: "c1" }),
    mkRecord({ id: "bug-flaky-c1", effective_category: "bug", subcategory: "flaky", cluster_id: "c1" }),
    mkRecord({ id: "bug-repro-c2", effective_category: "bug", subcategory: "repro", cluster_id: "c2" }),
    mkRecord({ id: "ux-color-c1", effective_category: "ux", subcategory: "color", cluster_id: "c1" }),
  ]
  const result = applyCompoundFilter(records, "bug › repro", "c1")
  assert.deepEqual(result.map((r) => r.id), ["bug-repro-c1"])
})

test("compound filter returns empty when both filters match disjoint subsets", () => {
  // This is the scoped-empty case the UI surfaces with the "Clear one
  // filter to widen the view" hint.
  const records = [
    mkRecord({ id: "1", effective_category: "bug", subcategory: "repro", cluster_id: "c1" }),
    mkRecord({ id: "2", effective_category: "ux", subcategory: "color", cluster_id: "c2" }),
  ]
  const result = applyCompoundFilter(records, "bug › repro", "c2")
  assert.deepEqual(result, [])
})

test("compound filter excludes cluster-less records when semanticClusterFilter is set", () => {
  // A record with cluster_id=null cannot satisfy a specific-cluster
  // filter, regardless of what the groupFilter says.
  const records = [
    mkRecord({ id: "1", effective_category: "bug", subcategory: "repro", cluster_id: null }),
    mkRecord({ id: "2", effective_category: "bug", subcategory: "repro", cluster_id: "c1" }),
  ]
  const result = applyCompoundFilter(records, "all", "c1")
  assert.deepEqual(result.map((r) => r.id), ["2"])
})

test("compound filter treats missing subcategory as 'General' for the group key", () => {
  // Mirrors the `record.subcategory || "General"` fallback in the memo
  // and in triageRecords. Without this parity, a record with a null
  // subcategory could never match any selectable group chip.
  const records = [
    mkRecord({ id: "1", effective_category: "bug", subcategory: null, cluster_id: "c1" }),
  ]
  const result = applyCompoundFilter(records, "bug › General", "all")
  assert.deepEqual(result.map((r) => r.id), ["1"])
})
