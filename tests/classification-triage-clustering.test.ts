import test from "node:test"
import assert from "node:assert/strict"

// Pure-function characterization of the compound-filter (triage group ×
// semantic cluster) logic and the label-confidence helpers used by
// components/dashboard/classification-triage.tsx.
//
// The semantic-cluster *aggregation* previously lived here as
// `computeSemanticClusters`; it moved server-side into
// lib/classification/clusters.ts (so the chip strip can render
// independent of the classification pipeline — see tests/clusters-
// aggregation.test.ts). What remains is the purely client-side
// filtering + label-trust decisions.

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
