import test from "node:test"
import assert from "node:assert/strict"

import {
  ERROR_REASONS,
  ERROR_SOURCES,
  FAMILY_KIND_VALUES,
  QUALITY_BUCKET_VALUES,
  REVIEW_DECISIONS,
  REVIEW_VERDICTS,
  buildFamilyReviewEvidenceSnapshot,
  isErrorReason,
  isErrorSource,
  isFamilyKind,
  isQualityBucket,
  isReviewDecision,
  isReviewVerdict,
  summarizeFamilyReviewRows,
  validateFamilyClassificationReviewInput,
} from "../lib/admin/family-classification-review.ts"

// --- Constant-set sanity ---------------------------------------------------
test("constant sets cover the expected values", () => {
  // These mirror the CHECK constraints in 030. If a value is added in
  // SQL but not in the helper, the API surface diverges from the table.
  assert.deepEqual([...REVIEW_VERDICTS], ["correct", "incorrect", "unclear"])
  assert.equal(REVIEW_DECISIONS.length, 8)
  assert.equal(ERROR_SOURCES.length, 10)
  assert.equal(ERROR_REASONS.length, 17)
  assert.equal(FAMILY_KIND_VALUES.length, 5)
  assert.equal(QUALITY_BUCKET_VALUES.length, 3)
})

// --- Type guards ------------------------------------------------------------
test("type guards accept canonical values and reject garbage", () => {
  assert.equal(isReviewVerdict("correct"), true)
  assert.equal(isReviewVerdict("INCORRECT"), false)
  assert.equal(isReviewVerdict(null), false)
  assert.equal(isReviewDecision("accept_heuristic"), true)
  assert.equal(isReviewDecision("accept-heuristic"), false)
  assert.equal(isReviewDecision(null), false)
  assert.equal(isErrorSource("stage_1_regex_topic"), true)
  assert.equal(isErrorSource("stage_4_llm_classification"), true)
  assert.equal(isErrorSource("layer_0_topic"), false)
  assert.equal(isErrorReason("wrong_family_kind"), true)
  assert.equal(isErrorReason("low_layer0_coverage"), false)
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
    assert.equal(result.value.error_source, null)
    assert.equal(result.value.error_reason, null)
    assert.equal(result.value.review_decision, null)
  }
})

test("correct verdict scrubs error_source / error_reason if accidentally provided", () => {
  // The form supports verdict toggles, so a reviewer flipping
  // incorrect → correct without resetting the dropdowns must not
  // poison the by_error_source summary.
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    errorSource: "stage_4_llm_classification",
    errorReason: "wrong_family_kind",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.error_source, null)
    assert.equal(result.value.error_reason, null)
  }
})

// --- Validator: incorrect verdict ------------------------------------------
test("incorrect verdict requires error_source", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorReason: "bad_family_title",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => /errorSource is required/i.test(e)),
      `expected errorSource-required error, got ${JSON.stringify(result.errors)}`,
    )
  }
})

test("incorrect verdict requires error_reason", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorSource: "stage_4_llm_classification",
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
    errorSource: "stage_4_llm_classification",
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
    errorSource: "stage_4_llm_classification",
    errorReason: "wrong_family_kind",
    expectedFamilyKind: "coherent_single_issue",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.expected_family_kind, "coherent_single_issue")
    assert.equal(result.value.error_reason, "wrong_family_kind")
    assert.equal(result.value.error_source, "stage_4_llm_classification")
  }
})

test("incorrect + non-wrong-kind reason does NOT require expected_family_kind", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorSource: "stage_4_llm_classification",
    errorReason: "llm_hallucinated",
  })
  assert.equal(result.ok, true)
})

// --- Validator: review_decision rules --------------------------------------
test("review_decision accepts canonical values", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    reviewDecision: "accept_heuristic",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.review_decision, "accept_heuristic")
  }
})

test("invalid review_decision rejected", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    reviewDecision: "accept-heuristic",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /reviewDecision must be one of/i.test(e)))
  }
})

test("review_decision = override_family_kind requires expected_family_kind", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorSource: "stage_4_llm_classification",
    errorReason: "llm_hallucinated",
    reviewDecision: "override_family_kind",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) =>
        /expectedFamilyKind is required when reviewDecision = override_family_kind/i.test(e),
      ),
      `expected override_family_kind error, got ${JSON.stringify(result.errors)}`,
    )
  }
})

test("review_decision = mark_low_evidence implies expected_family_kind = low_evidence", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorSource: "stage_4_llm_classification",
    errorReason: "low_evidence_should_not_be_coherent",
    reviewDecision: "mark_low_evidence",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.review_decision, "mark_low_evidence")
    assert.equal(result.value.expected_family_kind, "low_evidence")
  }
})

// --- Validator: tie-break contract -----------------------------------------
// See docs/CLUSTERING_DESIGN.md §5.2 "Stage 5 review contract".

test("disagreement row + correct + accept_heuristic is valid", () => {
  // Heuristic stored coherent_single_issue, LLM suggested
  // mixed_multi_causal — they disagreed. Reviewer agreed with the
  // heuristic: stored output is acceptable AND heuristic wins.
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    reviewDecision: "accept_heuristic",
    actualFamilyKind: "coherent_single_issue",
    llmSuggestedFamilyKind: "mixed_multi_causal",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.review_decision, "accept_heuristic")
  }
})

test("disagreement row + incorrect + accept_llm is valid", () => {
  // Same disagreement, reviewer sided with LLM: stored output is
  // wrong AND the LLM suggestion is the better answer.
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    reviewDecision: "accept_llm",
    actualFamilyKind: "coherent_single_issue",
    llmSuggestedFamilyKind: "mixed_multi_causal",
    errorSource: "stage_4_llm_classification",
    errorReason: "heuristic_overrode_better_llm_answer",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.review_decision, "accept_llm")
    assert.equal(result.value.review_verdict, "incorrect")
  }
})

test("disagreement row + correct + accept_llm is rejected", () => {
  // Stored output cannot be "correct" AND the LLM (which suggested a
  // different kind) is the better signal. Future Improvement Workbench
  // can't tell which side the human picked — reject so the data stays
  // unambiguous.
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    reviewDecision: "accept_llm",
    actualFamilyKind: "coherent_single_issue",
    llmSuggestedFamilyKind: "mixed_multi_causal",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) =>
        /correct with reviewDecision = accept_llm is not allowed/i.test(e),
      ),
      `expected contract-mismatch error, got ${JSON.stringify(result.errors)}`,
    )
  }
})

test("agreement row + correct + accept_llm is allowed", () => {
  // No disagreement (heuristic and LLM both said coherent_single_issue).
  // The reviewer is recording that the LLM had the better rationale
  // even though they happened to pick the same kind. This is the
  // intentional double-attribution case.
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    reviewDecision: "accept_llm",
    actualFamilyKind: "coherent_single_issue",
    llmSuggestedFamilyKind: "coherent_single_issue",
  })
  assert.equal(result.ok, true)
})

test("missing llmSuggestedFamilyKind does not block correct + accept_llm", () => {
  // Older clients / missing data — the validator can't prove
  // disagreement so it must let the row through. Improvement Workbench
  // will see review_decision but no tie_break_context and treat as
  // best-effort. This is the conservative branch.
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "correct",
    reviewDecision: "accept_llm",
    actualFamilyKind: "coherent_single_issue",
  })
  assert.equal(result.ok, true)
})

test("should_split_cluster defaults error_source to stage_3_clustering", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    reviewDecision: "should_split_cluster",
    errorReason: "mixed_cluster_should_split",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.error_source, "stage_3_clustering")
  }
})

test("should_split_cluster accepts representative_selection", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    reviewDecision: "should_split_cluster",
    errorSource: "representative_selection",
    errorReason: "bad_representatives",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.error_source, "representative_selection")
  }
})

test("should_split_cluster rejects unrelated error_source", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    reviewDecision: "should_split_cluster",
    errorSource: "stage_4_llm_classification",
    errorReason: "mixed_cluster_should_split",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) =>
        /errorSource must be stage_3_clustering or representative_selection/i.test(e),
      ),
      `expected error_source constraint error, got ${JSON.stringify(result.errors)}`,
    )
  }
})

test("unclear + needs_more_examples does not require error_source/error_reason", () => {
  // Reviewer can't decide and wants more reps before judging — we must
  // not force them to fabricate an error_source.
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "unclear",
    reviewDecision: "needs_more_examples",
    notes: "Only 2 reps, both ambiguous; want 5+ before deciding.",
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.error_source, null)
    assert.equal(result.value.error_reason, null)
    assert.equal(result.value.review_decision, "needs_more_examples")
  }
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

test("invalid error_source rejected", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorSource: "stage_99_warp_drive",
    errorReason: "bad_family_title",
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /errorSource must be one of/i.test(e)))
  }
})

test("invalid error_reason rejected", () => {
  const result = validateFamilyClassificationReviewInput({
    classificationId: "c1",
    clusterId: "k1",
    reviewVerdict: "incorrect",
    errorSource: "stage_4_llm_classification",
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
    errorSource: "stage_4_llm_classification",
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
  // tie_break_context: heuristic and LLM agreed → llm_disagrees false.
  assert.ok(snapshot.tie_break_context)
  const tieBreak = snapshot.tie_break_context as Record<string, unknown>
  assert.equal(tieBreak.heuristic_family_kind, "coherent_single_issue")
  assert.equal(tieBreak.llm_suggested_family_kind, "coherent_single_issue")
  assert.equal(tieBreak.llm_disagrees, false)
  assert.equal(tieBreak.review_decision, null)
})

test("buildFamilyReviewEvidenceSnapshot records tie_break_context when LLM disagrees", () => {
  const snapshot = buildFamilyReviewEvidenceSnapshot({
    classification_id: "abc",
    cluster_id: "klu",
    family_kind: "coherent_single_issue",
    review_decision: "accept_llm",
    evidence: {
      llm: {
        status: "succeeded",
        suggested_family_kind: "mixed_multi_causal",
        rationale: "Reps describe two distinct failure modes.",
      },
    },
  })

  const tieBreak = snapshot.tie_break_context as Record<string, unknown>
  assert.ok(tieBreak)
  assert.equal(tieBreak.heuristic_family_kind, "coherent_single_issue")
  assert.equal(tieBreak.llm_suggested_family_kind, "mixed_multi_causal")
  assert.equal(tieBreak.llm_disagrees, true)
  assert.equal(tieBreak.review_decision, "accept_llm")
})

test("buildFamilyReviewEvidenceSnapshot uses explicit llm_suggested_family_kind", () => {
  // Component path: when the panel has the LLM suggestion in a
  // sidecar field rather than in `evidence.llm`.
  const snapshot = buildFamilyReviewEvidenceSnapshot({
    classification_id: "abc",
    cluster_id: "klu",
    family_kind: "low_evidence",
    llm_suggested_family_kind: "coherent_single_issue",
    review_decision: "accept_heuristic",
  })
  const tieBreak = snapshot.tie_break_context as Record<string, unknown>
  assert.equal(tieBreak.heuristic_family_kind, "low_evidence")
  assert.equal(tieBreak.llm_suggested_family_kind, "coherent_single_issue")
  assert.equal(tieBreak.llm_disagrees, true)
  assert.equal(tieBreak.review_decision, "accept_heuristic")
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
  assert.equal(summary.top_error_source, null)
  assert.equal(summary.top_error_reason, null)
  assert.equal(summary.tie_break_reviewed_count, 0)
  assert.equal(summary.heuristic_accepted_count, 0)
  assert.equal(summary.llm_accepted_count, 0)
  assert.equal(summary.override_family_kind_count, 0)
  assert.equal(summary.low_evidence_override_count, 0)
  assert.equal(summary.general_feedback_marked_count, 0)
  assert.equal(summary.needs_more_examples_count, 0)
  assert.equal(summary.should_split_cluster_count, 0)
  assert.equal(summary.not_actionable_count, 0)
})

test("summarizeFamilyReviewRows computes precision and top error source/reason", () => {
  const summary = summarizeFamilyReviewRows([
    {
      review_verdict: "correct",
      review_decision: null,
      quality_bucket: "safe_to_trust",
      error_source: null,
      error_reason: null,
    },
    {
      review_verdict: "incorrect",
      review_decision: null,
      quality_bucket: "safe_to_trust",
      error_source: "stage_4_llm_classification",
      error_reason: "wrong_family_kind",
    },
    {
      review_verdict: "correct",
      review_decision: null,
      quality_bucket: "needs_review",
      error_source: null,
      error_reason: null,
    },
    {
      review_verdict: "incorrect",
      review_decision: null,
      quality_bucket: "input_problem",
      error_source: "data_quality",
      error_reason: "bad_cluster_membership",
    },
    {
      review_verdict: "incorrect",
      review_decision: null,
      quality_bucket: "needs_review",
      error_source: "stage_4_llm_classification",
      error_reason: "wrong_family_kind",
    },
    {
      review_verdict: "unclear",
      review_decision: null,
      quality_bucket: "needs_review",
      error_source: null,
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
  // stage_4_llm_classification appears twice in error_source → top.
  assert.equal(summary.top_error_source, "stage_4_llm_classification")
  // wrong_family_kind appears twice in error_reason → top.
  assert.equal(summary.top_error_reason, "wrong_family_kind")
})

test("summarizeFamilyReviewRows by_quality_bucket tracks per-verdict counts", () => {
  const summary = summarizeFamilyReviewRows([
    {
      review_verdict: "correct",
      review_decision: null,
      quality_bucket: "safe_to_trust",
      error_source: null,
      error_reason: null,
    },
    {
      review_verdict: "correct",
      review_decision: null,
      quality_bucket: "safe_to_trust",
      error_source: null,
      error_reason: null,
    },
    {
      review_verdict: "incorrect",
      review_decision: null,
      quality_bucket: "safe_to_trust",
      error_source: "stage_4_llm_classification",
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

test("summarizeFamilyReviewRows tracks tie-break decisions", () => {
  const summary = summarizeFamilyReviewRows([
    {
      review_verdict: "correct",
      review_decision: "accept_heuristic",
      quality_bucket: "safe_to_trust",
      error_source: null,
      error_reason: null,
    },
    {
      review_verdict: "incorrect",
      review_decision: "accept_llm",
      quality_bucket: "needs_review",
      error_source: "stage_4_llm_classification",
      error_reason: "heuristic_overrode_better_llm_answer",
    },
    {
      review_verdict: "correct",
      review_decision: "accept_heuristic",
      quality_bucket: "needs_review",
      error_source: null,
      error_reason: null,
    },
    {
      review_verdict: "incorrect",
      review_decision: "override_family_kind",
      quality_bucket: "needs_review",
      error_source: "stage_4_llm_classification",
      error_reason: "wrong_family_kind",
    },
  ])

  // tie_break_reviewed_count counts every review with a non-null
  // review_decision; the per-decision counters are independent so the
  // dashboard can render a tile per outcome.
  assert.equal(summary.tie_break_reviewed_count, 4)
  assert.equal(summary.heuristic_accepted_count, 2)
  assert.equal(summary.llm_accepted_count, 1)
  assert.equal(summary.override_family_kind_count, 1)
  assert.equal(summary.low_evidence_override_count, 0)
  assert.equal(summary.by_review_decision.accept_heuristic, 2)
  assert.equal(summary.by_review_decision.accept_llm, 1)
  assert.equal(summary.by_review_decision.override_family_kind, 1)
})

test("summarizeFamilyReviewRows tracks all 8 review_decision tiles", () => {
  const summary = summarizeFamilyReviewRows([
    { review_verdict: "correct", review_decision: "accept_heuristic", quality_bucket: null, error_source: null, error_reason: null },
    { review_verdict: "incorrect", review_decision: "accept_llm", quality_bucket: null, error_source: "stage_4_llm_classification", error_reason: "heuristic_overrode_better_llm_answer" },
    { review_verdict: "incorrect", review_decision: "override_family_kind", quality_bucket: null, error_source: "stage_4_llm_classification", error_reason: "wrong_family_kind" },
    { review_verdict: "incorrect", review_decision: "mark_low_evidence", quality_bucket: null, error_source: "data_quality", error_reason: "low_evidence_should_not_be_coherent" },
    { review_verdict: "incorrect", review_decision: "mark_general_feedback", quality_bucket: null, error_source: "data_quality", error_reason: "general_feedback_not_actionable" },
    { review_verdict: "unclear", review_decision: "needs_more_examples", quality_bucket: null, error_source: null, error_reason: null },
    { review_verdict: "incorrect", review_decision: "should_split_cluster", quality_bucket: null, error_source: "stage_3_clustering", error_reason: "mixed_cluster_should_split" },
    { review_verdict: "unclear", review_decision: "not_actionable", quality_bucket: null, error_source: null, error_reason: null },
  ])

  assert.equal(summary.tie_break_reviewed_count, 8)
  assert.equal(summary.heuristic_accepted_count, 1)
  assert.equal(summary.llm_accepted_count, 1)
  assert.equal(summary.override_family_kind_count, 1)
  assert.equal(summary.low_evidence_override_count, 1)
  assert.equal(summary.general_feedback_marked_count, 1)
  assert.equal(summary.needs_more_examples_count, 1)
  assert.equal(summary.should_split_cluster_count, 1)
  assert.equal(summary.not_actionable_count, 1)
})

test("summarizeFamilyReviewRows: correct + accept_llm (agreement-row case) is double-attributed", () => {
  // The validator only lets `correct + accept_llm` rows through when
  // heuristic and LLM agreed (i.e. they picked the same family_kind
  // and the reviewer is just recording that the LLM's rationale was
  // the stronger signal). When that row reaches the summary it
  // contributes to BOTH correct_count AND llm_accepted_count — the
  // double-attribution is the intended behaviour for this narrow case.
  const summary = summarizeFamilyReviewRows([
    {
      review_verdict: "correct",
      review_decision: "accept_llm",
      quality_bucket: "needs_review",
      error_source: null,
      error_reason: null,
    },
  ])

  assert.equal(summary.correct_count, 1)
  assert.equal(summary.llm_accepted_count, 1)
  assert.equal(summary.tie_break_reviewed_count, 1)
})
