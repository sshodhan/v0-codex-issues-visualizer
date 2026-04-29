import test from "node:test"
import assert from "node:assert/strict"

import {
  BAD_LLM_STATUSES,
  deriveBucketCounts,
  filterRowsByBucket,
  isBadLlmStatus,
  normalizeQualityRow,
  type QualityRow,
} from "../lib/admin/family-classification-quality-ui.ts"

function makeRow(overrides: Partial<QualityRow> = {}): QualityRow {
  return {
    classification_id: null,
    cluster_id: "cluster-1",
    quality_bucket: "needs_review",
    family_kind: null,
    family_title: null,
    family_summary: null,
    confidence: null,
    recommended_action: "",
    review_reasons: [],
    quality_reasons: [],
    classification_coverage_share: null,
    mixed_topic_score: null,
    observation_count: 0,
    llm_status: null,
    llm_model: null,
    llm_suggested_family_kind: null,
    representative_count: 0,
    representative_preview: [],
    common_matched_phrase_count: 0,
    common_matched_phrase_preview: [],
    needs_human_review: false,
    algorithm_version: null,
    classified_at: null,
    llm_classified_at: null,
    updated_at: null,
    ...overrides,
  }
}

// LLM-status counting was the bug that motivated this dashboard's
// review — `succeeded` was being miscounted as failed/skipped because
// the original check compared to "success". The set must accept both
// success vocabularies as "good" and treat the listed bad ones as bad.
test("isBadLlmStatus: succeeded/success are not bad", () => {
  assert.equal(isBadLlmStatus("succeeded"), false)
  assert.equal(isBadLlmStatus("success"), false)
  assert.equal(isBadLlmStatus(null), false)
  assert.equal(isBadLlmStatus(undefined), false)
  assert.equal(isBadLlmStatus(""), false)
})

test("isBadLlmStatus: failed/error/auth_error are bad", () => {
  assert.equal(isBadLlmStatus("failed"), true)
  assert.equal(isBadLlmStatus("error"), true)
  assert.equal(isBadLlmStatus("auth_error"), true)
})

test("isBadLlmStatus: skipped_* and low_confidence_fallback are bad", () => {
  assert.equal(isBadLlmStatus("skipped_missing_api_key"), true)
  assert.equal(isBadLlmStatus("skipped_no_representatives"), true)
  assert.equal(isBadLlmStatus("low_confidence_fallback"), true)
})

test("isBadLlmStatus: needs_review and needs_human_review are bad", () => {
  assert.equal(isBadLlmStatus("needs_review"), true)
  assert.equal(isBadLlmStatus("needs_human_review"), true)
})

test("BAD_LLM_STATUSES set has expected members", () => {
  for (const s of [
    "failed",
    "error",
    "auth_error",
    "skipped_missing_api_key",
    "skipped_no_representatives",
    "low_confidence_fallback",
    "needs_review",
    "needs_human_review",
  ]) {
    assert.ok(BAD_LLM_STATUSES.has(s), `expected ${s} to be in BAD_LLM_STATUSES`)
  }
  // Successful vocabularies must NOT be in the bad set.
  assert.equal(BAD_LLM_STATUSES.has("succeeded"), false)
  assert.equal(BAD_LLM_STATUSES.has("success"), false)
})

// deriveBucketCounts — fallback to recomputing counts from rows when
// the server summary is missing or empty.
test("deriveBucketCounts: uses server summary when present", () => {
  const summary = { bucket_counts: { safe_to_trust: 5, needs_review: 2 } }
  const counts = deriveBucketCounts(summary, [])
  assert.deepEqual(counts, { safe_to_trust: 5, needs_review: 2 })
})

test("deriveBucketCounts: falls back to row counts when summary is missing", () => {
  const rows: QualityRow[] = [
    makeRow({ cluster_id: "a", quality_bucket: "safe_to_trust" }),
    makeRow({ cluster_id: "b", quality_bucket: "safe_to_trust" }),
    makeRow({ cluster_id: "c", quality_bucket: "needs_review" }),
    makeRow({ cluster_id: "d", quality_bucket: "input_problem" }),
  ]
  const counts = deriveBucketCounts(undefined, rows)
  assert.deepEqual(counts, { safe_to_trust: 2, needs_review: 1, input_problem: 1 })
})

test("deriveBucketCounts: falls back when summary.bucket_counts is empty object", () => {
  const rows: QualityRow[] = [
    makeRow({ cluster_id: "a", quality_bucket: "needs_review" }),
    makeRow({ cluster_id: "b", quality_bucket: "needs_review" }),
  ]
  const counts = deriveBucketCounts({ bucket_counts: {} }, rows)
  assert.deepEqual(counts, { needs_review: 2 })
})

test("deriveBucketCounts: missing summary does not break — returns {} for empty rows", () => {
  const counts = deriveBucketCounts(undefined, [])
  assert.deepEqual(counts, {})
})

// Bucket filter — operator-facing triage control.
test("filterRowsByBucket: 'all' returns everything", () => {
  const rows: QualityRow[] = [
    makeRow({ cluster_id: "a", quality_bucket: "safe_to_trust" }),
    makeRow({ cluster_id: "b", quality_bucket: "needs_review" }),
    makeRow({ cluster_id: "c", quality_bucket: "input_problem" }),
  ]
  assert.equal(filterRowsByBucket(rows, "all").length, 3)
})

test("filterRowsByBucket: filters to a single bucket", () => {
  const rows: QualityRow[] = [
    makeRow({ cluster_id: "a", quality_bucket: "safe_to_trust" }),
    makeRow({ cluster_id: "b", quality_bucket: "needs_review" }),
    makeRow({ cluster_id: "c", quality_bucket: "needs_review" }),
    makeRow({ cluster_id: "d", quality_bucket: "input_problem" }),
  ]
  assert.equal(filterRowsByBucket(rows, "safe_to_trust").length, 1)
  assert.equal(filterRowsByBucket(rows, "needs_review").length, 2)
  assert.equal(filterRowsByBucket(rows, "input_problem").length, 1)
})

// normalizeQualityRow — defensive against shape drift. The dashboard
// must still render if the API switches from snake_case to camelCase
// or sends partial rows.
test("normalizeQualityRow: returns null for non-objects and missing cluster_id", () => {
  assert.equal(normalizeQualityRow(null), null)
  assert.equal(normalizeQualityRow(undefined), null)
  assert.equal(normalizeQualityRow(42), null)
  assert.equal(normalizeQualityRow("string"), null)
  assert.equal(normalizeQualityRow({}), null)
  assert.equal(normalizeQualityRow({ cluster_id: "" }), null)
})

test("normalizeQualityRow: parses the canonical snake_case shape", () => {
  const row = normalizeQualityRow({
    cluster_id: "abc",
    quality_bucket: "safe_to_trust",
    family_kind: "coherent_single_issue",
    recommended_action: "trust",
    review_reasons: ["foo", "bar"],
    quality_reasons: ["passes_strict_quality_criteria"],
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.1,
    observation_count: 12,
    llm_status: "success",
    llm_model: "gpt-4",
    representative_count: 3,
    representative_preview: ["a", "b"],
    common_matched_phrase_count: 5,
    common_matched_phrase_preview: ["x"],
    needs_human_review: false,
    algorithm_version: "v1",
    classified_at: "2026-01-01T00:00:00Z",
    llm_classified_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  })
  assert.ok(row)
  assert.equal(row?.cluster_id, "abc")
  assert.equal(row?.quality_bucket, "safe_to_trust")
  assert.equal(row?.classification_coverage_share, 0.9)
  assert.equal(row?.observation_count, 12)
  assert.deepEqual(row?.representative_preview, ["a", "b"])
})

test("normalizeQualityRow: tolerates camelCase field renames", () => {
  const row = normalizeQualityRow({
    clusterId: "abc",
    qualityBucket: "input_problem",
    familyKind: "low_evidence",
    recommendedAction: "fix evidence",
    reviewReasons: ["r1"],
    qualityReasons: ["missing_evidence"],
    classificationCoverageShare: 0.4,
    mixedTopicScore: 0.5,
    observationCount: 7,
    llmStatus: "error",
    representativeCount: 0,
    representativePreview: [],
    commonMatchedPhraseCount: 0,
    commonMatchedPhrasePreview: [],
    needsHumanReview: true,
  })
  assert.ok(row)
  assert.equal(row?.cluster_id, "abc")
  assert.equal(row?.quality_bucket, "input_problem")
  assert.equal(row?.family_kind, "low_evidence")
  assert.equal(row?.observation_count, 7)
  assert.equal(row?.needs_human_review, true)
  assert.equal(row?.llm_status, "error")
})

test("normalizeQualityRow: defaults unknown bucket to needs_review", () => {
  const row = normalizeQualityRow({ cluster_id: "abc", quality_bucket: "garbage" })
  assert.ok(row)
  assert.equal(row?.quality_bucket, "needs_review")
})

test("normalizeQualityRow: numeric strings are coerced; non-numeric become null/0", () => {
  const row = normalizeQualityRow({
    cluster_id: "abc",
    classification_coverage_share: "0.75",
    observation_count: "42",
    mixed_topic_score: "not-a-number",
  })
  assert.equal(row?.classification_coverage_share, 0.75)
  assert.equal(row?.observation_count, 42)
  assert.equal(row?.mixed_topic_score, null)
})

test("normalizeQualityRow: malformed array fields default to []", () => {
  const row = normalizeQualityRow({
    cluster_id: "abc",
    review_reasons: "not-an-array",
    representative_preview: { 0: "a" },
  })
  assert.deepEqual(row?.review_reasons, [])
  assert.deepEqual(row?.representative_preview, [])
})
