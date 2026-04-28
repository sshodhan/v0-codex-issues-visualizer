import test from "node:test"
import assert from "node:assert/strict"

import {
  ERROR_LAYERS,
  ERROR_REASONS,
  FAMILY_KIND_VALUES,
  QUALITY_BUCKET_VALUES,
  REVIEW_VERDICTS,
  buildFamilyReviewEvidenceSnapshot,
  isErrorLayer,
  isErrorReason,
  isFamilyKind,
  isQualityBucket,
  isReviewVerdict,
  summarizeFamilyReviewRows,
  validateFamilyClassificationReviewInput,
} from "../lib/admin/family-classification-review.ts"

// --- Constant-set sanity ---------------------------------------------------
test("constant sets cover the expected values", () => {
  // These mirror the CHECK constraints in 030. If a value is added in
  // SQL but not in the helper, the API surface diverges from the table.
  assert.deepEqual([...REVIEW_VERDICTS], ["correct", "incorrect", "unclear"])
  assert.equal(ERROR_LAYERS.length, 7)
  assert.equal(ERROR_REASONS.length, 15)
  assert.equal(FAMILY_KIND_VALUES.length, 5)
  assert.equal(QUALITY_BUCKET_VALUES.length, 3)
})

// --- Type guards ------------------------------------------------------------
test("type guards accept canonical values and reject garbage", () => {
  assert.equal(isReviewVerdict("correct"), true)
  assert.equal(isReviewVerdict("INCORRECT"), false)
  assert.equal(isReviewVerdict(null), false)
  assert.equal(isErrorLayer("layer_0_topic"), true)
  assert.equal(isErrorLayer("layer_zero"), false)
  assert.equal(isErrorReason("wrong_family_kind"), true)
  assert.equal(isErrorReason("kaboom"), false)
  assert.equal(isFamilyKind("coherent_single_issue"), true)
  assert.equal(isFamilyKind("coherent"), false)
  assert.equal(isQualityBucket("safe_to_trust"), true)
  assert.equal(isQualityBucket("trustworthy"), false)
})

// --- Validator: correct verdict --------------------------------------------
test("correct verdict passes with minimal fields", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.review_verdict, "correct")
    assert.equal(result.value.error_layer, null)
    assert.equal(result.value.error_reason, null)
  }
})

test("correct verdict scrubs error_layer / error_reason if accidentally provided", () => {
  // The form supports verdict toggles, so a reviewer flipping
  // incorrect → correct without resetting the dropdowns must not
  // poison the by_error_layer summary.
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    errorLayer: "family_classification",
    errorReason: "wrong_family_kind",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.error_layer, null)
    assert.equal(result.value.error_reason, null)
  }
})

// --- Validator: incorrect verdict ------------------------------------------
test("incorrect verdict requires error_layer", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorReason: "bad_family_title",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => /errorLayer is required/i.test(e)),
      `expected errorLayer-required error, got ${JSON.stringify(result.errors)}`,
    )
  }
})

test("incorrect verdict requires error_reason", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorLayer: "family_classification",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /errorReason is required/i.test(e)))
  }
})

test("incorrect + wrong_family_kind requires expected_family_kind", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorLayer: "family_classification",
    errorReason: "wrong_family_kind",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => /expectedFamilyKind is required/i.test(e)),
      `expected expectedFamilyKind error, got ${JSON.stringify(result.errors)}`,
    )
  }
})

test("incorrect + wrong_family_kind passes when expected_family_kind is provided", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorLayer: "family_classification",
    errorReason: "wrong_family_kind",
    expectedFamilyKind: "coherent_single_issue",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.expected_family_kind, "coherent_single_issue")
    assert.equal(result.value.error_reason, "wrong_family_kind")
  }
})

test("incorrect + non-wrong-kind reason does NOT require expected_family_kind", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorLayer: "llm_enrichment",
    errorReason: "llm_hallucinated",
  })
  assert.equal(result.ok, true)
})

// --- Validator: unclear verdict --------------------------------------------
test("unclear verdict passes with no notes", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "unclear",
  })
  assert.equal(result.ok, true)
})

test("unclear verdict passes with optional notes", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "unclear",
    notes: "Depends on whether we count cancelled connections as failures.",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.match(result.value.notes ?? "", /cancelled/)
  }
})

// --- Validator: required-field errors --------------------------------------
test("missing classificationId fails", () => {
  const result = validateFamilyClassificationReviewInput({
    clusterId: "k1",
    reviewVerdict: "correct",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /classificationId is required/i.test(e)))
  }
})

test("missing clusterId fails", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    reviewVerdict: "correct",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /clusterId is required/i.test(e)))
  }
})

test("invalid review_verdict rejected", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "wrong",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /reviewVerdict must be one of/i.test(e)))
  }
})

test("invalid error_layer rejected", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorLayer: "layer_z",
    errorReason: "bad_family_title",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /errorLayer must be one of/i.test(e)))
  }
})

test("invalid error_reason rejected", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorLayer: "family_classification",
    errorReason: "wrong_color",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /errorReason must be one of/i.test(e)))
  }
})

test("invalid quality_bucket rejected", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    qualityBucket: "trustworthy",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /qualityBucket must be one of/i.test(e)))
  }
})

test("invalid expected_family_kind rejected", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorLayer: "family_classification",
    errorReason: "wrong_family_kind",
    expectedFamilyKind: "coherent",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /expectedFamilyKind must be one of/i.test(e)))
  }
})

test("notes are trimmed; empty strings normalise to null", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "unclear",
    notes: "   ",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.notes, null)
  }
})

test("notes are truncated to NOTES_MAX_LENGTH", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "unclear",
    notes: "x".repeat(5000),
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.notes?.length, 4000)
  }
})

// --- Evidence snapshot builder --------------------------------------------
test("buildFamilyReviewEvidenceSnapshot includes the key audit fields", () => {
  const snapshot = buildFamilyReviewEvidenceSnapshot({
    classification_id: "abc",
    cluster_id: "klu",
    family_title: "Auth fails after upgrade",
    family_summary: "Users see 401 after CLI upgrade",
    family_kind: "coherent_single_issue",
    quality_bucket: "safe_to_trust",
    quality_reasons: ["passes_strict_quality_criteria"],
    recommended_action: "trust",
    confidence: 0.91,
    needs_human_review: false,
    review_reasons: [],
    representative_count: 5,
    representative_preview: ["Login broken", "401 from CLI", "Need to re-auth"],
    common_matched_phrase_count: 4,
    common_matched_phrase_preview: ["401 unauthorized", "auth failure"],
    evidence: {
      llm: {
        status: "succeeded",
        suggested_family_kind: "coherent_single_issue",
        rationale: "Reps all describe same auth flow regression.",
      },
      cluster_topic_metadata: {
        cluster_path: "semantic",
        observation_count: 42,
        classification_coverage_share: 0.95,
        dominant_topic_slug: "authentication",
        dominant_topic_share: 0.83,
        mixed_topic_score: 0.12,
        avg_confidence_proxy: 0.74,
        low_margin_count: 1,
        low_margin_share: 0.024,
      },
    },
  })

  assert.equal(snapshot.classification_id, "abc")
  assert.equal(snapshot.family_title, "Auth fails after upgrade")
  assert.equal(snapshot.quality_bucket, "safe_to_trust")
  assert.equal(snapshot.confidence, 0.91)
  assert.deepEqual(snapshot.quality_reasons, ["passes_strict_quality_criteria"])
  assert.equal(snapshot.representative_count, 5)
  assert.deepEqual(snapshot.representative_preview, [
    "Login broken",
    "401 from CLI",
    "Need to re-auth",
  ])
  // LLM block present and rationale preserved when short.
  assert.ok(snapshot.llm)
  const llm = snapshot.llm as Record<string, unknown>
  assert.equal(llm.status, "succeeded")
  assert.equal(llm.suggested_family_kind, "coherent_single_issue")
  assert.match(String(llm.rationale), /auth flow/)
  // Cluster topic metadata block carried.
  assert.ok(snapshot.cluster_topic_metadata)
  const meta = snapshot.cluster_topic_metadata as Record<string, unknown>
  assert.equal(meta.cluster_path, "semantic")
  assert.equal(meta.observation_count, 42)
  assert.equal(meta.dominant_topic_slug, "authentication")
})

test("buildFamilyReviewEvidenceSnapshot bounds rationale and previews", () => {
  const longRationale = "lorem ipsum ".repeat(200) // ~2400 chars
  const snapshot = buildFamilyReviewEvidenceSnapshot({
    classification_id: "abc",
    cluster_id: "klu",
    family_kind: "low_evidence",
    quality_bucket: "needs_review",
    representative_preview: Array.from({ length: 20 }, (_, i) => `rep-${i}`),
    common_matched_phrase_preview: Array.from(
      { length: 20 },
      (_, i) => `phrase-${i}`,
    ),
    evidence: {
      llm: {
        status: "succeeded",
        suggested_family_kind: "low_evidence",
        rationale: longRationale,
      },
    },
  })

  const reps = snapshot.representative_preview as string[]
  assert.equal(reps.length, 5)
  const phrases = snapshot.common_matched_phrase_preview as string[]
  assert.equal(phrases.length, 8)
  const llm = snapshot.llm as Record<string, unknown>
  // rationale truncated to ~1000 chars + ellipsis. Must be substantially
  // shorter than the input.
  assert.ok(typeof llm.rationale === "string")
  assert.ok(
    String(llm.rationale).length <= 1010,
    `rationale should be capped, got ${String(llm.rationale).length}`,
  )
})

test("buildFamilyReviewEvidenceSnapshot tolerates a null/empty row", () => {
  assert.deepEqual(buildFamilyReviewEvidenceSnapshot(null), {})
  assert.deepEqual(buildFamilyReviewEvidenceSnapshot(undefined), {})
})

// --- Summary helper --------------------------------------------------------
test("summarizeFamilyReviewRows returns zeros for an empty list", () => {
  const summary = summarizeFamilyReviewRows([])
  assert.equal(summary.reviewed_count, 0)
  assert.equal(summary.correct_count, 0)
  assert.equal(summary.incorrect_count, 0)
  assert.equal(summary.unclear_count, 0)
  assert.equal(summary.safe_to_trust_precision, null)
  assert.equal(summary.top_error_layer, null)
  assert.equal(summary.top_error_reason, null)
})

test("summarizeFamilyReviewRows computes precision and top error layer/reason", () => {
  const summary = summarizeFamilyReviewRows([
    {
      review_verdict: "correct",
      quality_bucket: "safe_to_trust",
      error_layer: null,
      error_reason: null,
    },
    {
      review_verdict: "incorrect",
      quality_bucket: "safe_to_trust",
      error_layer: "family_classification",
      error_reason: "wrong_family_kind",
    },
    {
      review_verdict: "correct",
      quality_bucket: "needs_review",
      error_layer: null,
      error_reason: null,
    },
    {
      review_verdict: "incorrect",
      quality_bucket: "input_problem",
      error_layer: "data_quality",
      error_reason: "low_layer0_coverage",
    },
    {
      review_verdict: "incorrect",
      quality_bucket: "needs_review",
      error_layer: "family_classification",
      error_reason: "wrong_family_kind",
    },
    {
      review_verdict: "unclear",
      quality_bucket: "needs_review",
      error_layer: null,
      error_reason: null,
    },
  ])

  assert.equal(summary.reviewed_count, 6)
  assert.equal(summary.correct_count, 2)
  assert.equal(summary.incorrect_count, 3)
  assert.equal(summary.unclear_count, 1)
  // safe_to_trust: 1 correct of 2 reviewed → 0.5 precision.
  assert.equal(summary.safe_to_trust_reviewed, 2)
  assert.equal(summary.safe_to_trust_correct, 1)
  assert.equal(summary.safe_to_trust_precision, 0.5)
  // input_problem: 1 of 1 confirmed incorrect → reviewer agreed.
  assert.equal(summary.input_problem_reviewed, 1)
  assert.equal(summary.input_problem_confirmed, 1)
  // family_classification appears twice in error_layer → top.
  assert.equal(summary.top_error_layer, "family_classification")
  // wrong_family_kind appears twice in error_reason → top.
  assert.equal(summary.top_error_reason, "wrong_family_kind")
})

test("summarizeFamilyReviewRows by_quality_bucket tracks per-verdict counts", () => {
  const summary = summarizeFamilyReviewRows([
    {
      review_verdict: "correct",
      quality_bucket: "safe_to_trust",
      error_layer: null,
      error_reason: null,
    },
    {
      review_verdict: "correct",
      quality_bucket: "safe_to_trust",
      error_layer: null,
      error_reason: null,
    },
    {
      review_verdict: "incorrect",
      quality_bucket: "safe_to_trust",
      error_layer: "llm_enrichment",
      error_reason: "llm_hallucinated",
    },
  ])

  const bucket = summary.by_quality_bucket.safe_to_trust
  assert.ok(bucket)
  assert.equal(bucket.reviewed, 3)
  assert.equal(bucket.correct, 2)
  assert.equal(bucket.incorrect, 1)
  assert.equal(bucket.unclear, 0)
})
