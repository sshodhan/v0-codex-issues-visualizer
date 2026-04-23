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
  cluster_label: string | null
  cluster_size: number | null
}

// Mirrors the `semanticClusters` memo in classification-triage.tsx.
// Records without a cluster_id are skipped so the chip strip only shows
// actionable clusters. Label/size are captured from the first record seen
// for each cluster_id — callers rely on the API returning identical
// cluster metadata for every record that shares a cluster_id.
function computeSemanticClusters(records: MinimalRecord[]) {
  const grouped = new Map<
    string,
    { id: string; label: string | null; size: number; total: number }
  >()
  for (const record of records) {
    if (!record.cluster_id) continue
    const current = grouped.get(record.cluster_id) ?? {
      id: record.cluster_id,
      label: record.cluster_label,
      size: record.cluster_size ?? 0,
      total: 0,
    }
    current.total += 1
    grouped.set(record.cluster_id, current)
  }
  return Array.from(grouped.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
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
  cluster_label: null,
  cluster_size: null,
  ...partial,
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
    mkRecord({ id: "1", cluster_id: "c1", cluster_label: "Repo scan hangs", cluster_size: 7 }),
    mkRecord({ id: "2", cluster_id: "c1", cluster_label: "Repo scan hangs", cluster_size: 7 }),
    mkRecord({ id: "3", cluster_id: "c2", cluster_label: "Auth token expires", cluster_size: 3 }),
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

test("semanticClusters sorts by in-scope total descending", () => {
  const records = [
    mkRecord({ id: "1", cluster_id: "small" }),
    mkRecord({ id: "2", cluster_id: "big" }),
    mkRecord({ id: "3", cluster_id: "big" }),
    mkRecord({ id: "4", cluster_id: "big" }),
    mkRecord({ id: "5", cluster_id: "medium" }),
    mkRecord({ id: "6", cluster_id: "medium" }),
  ]
  const result = computeSemanticClusters(records)
  assert.deepEqual(result.map((c) => c.id), ["big", "medium", "small"])
})

test("semanticClusters caps at top 10 to keep the chip strip readable", () => {
  const records = Array.from({ length: 15 }, (_, i) =>
    mkRecord({ id: `r${i}`, cluster_id: `c${i}` }),
  )
  const result = computeSemanticClusters(records)
  assert.equal(result.length, 10)
})

test("semanticClusters preserves null label when cluster is unlabelled", () => {
  // Labelling can lag behind clustering (or be deleted entirely per the
  // measurable-decision rule in docs/ARCHITECTURE.md). The UI renders
  // "Unlabelled cluster" in that case — but the memo must pass the null
  // through verbatim, not substitute a string.
  const records = [mkRecord({ id: "1", cluster_id: "c1", cluster_label: null })]
  const result = computeSemanticClusters(records)
  assert.equal(result.length, 1)
  assert.equal(result[0].label, null)
})

test("semanticClusters treats null cluster_size as 0, not undefined", () => {
  const records = [mkRecord({ id: "1", cluster_id: "c1", cluster_size: null })]
  const result = computeSemanticClusters(records)
  assert.equal(result[0].size, 0)
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
