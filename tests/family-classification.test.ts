import test from "node:test"
import assert from "node:assert/strict"

// These are pure-function tests for the family classification heuristic rules.
// We test the decision logic without requiring Supabase or OpenAI.

// Copy the heuristic logic for testing (or export it separately in the main module).
// For now, inline the deterministic rule logic so tests are self-contained.

type FamilyKind =
  | "coherent_single_issue"
  | "mixed_multi_causal"
  | "needs_split_review"
  | "low_evidence"
  | "unclear"

interface HeuristicResult {
  family_kind: FamilyKind
  needs_human_review: boolean
  review_reasons: string[]
}

function classifyFamilyHeuristic(input: {
  classification_coverage_share: number
  mixed_topic_score: number
  dominant_topic_share: number
}): HeuristicResult {
  if (input.classification_coverage_share < 0.5) {
    return {
      family_kind: "low_evidence",
      needs_human_review: true,
      review_reasons: ["low_classification_coverage"],
    }
  }

  if (input.mixed_topic_score >= 0.6 && input.classification_coverage_share >= 0.8) {
    return {
      family_kind: "needs_split_review",
      needs_human_review: true,
      review_reasons: ["high_topic_mixedness"],
    }
  }

  if (input.dominant_topic_share >= 0.75) {
    return {
      family_kind: "coherent_single_issue",
      needs_human_review: false,
      review_reasons: [],
    }
  }

  return {
    family_kind: "unclear",
    needs_human_review: true,
    review_reasons: ["mixed_or_unclear_signals"],
  }
}

// ============================================================================
// Tests
// ============================================================================

test("low_coverage < 0.5 → low_evidence + needs_human_review", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.3,
    mixed_topic_score: 0.2,
    dominant_topic_share: 0.8,
  })
  assert.equal(result.family_kind, "low_evidence")
  assert.equal(result.needs_human_review, true)
  assert.deepEqual(result.review_reasons, ["low_classification_coverage"])
})

test("coverage at 0.5 boundary is not low_evidence", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.5,
    mixed_topic_score: 0.1,
    dominant_topic_share: 0.8,
  })
  // Should fall through to dominant_topic_share >= 0.75 → coherent_single_issue
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, false)
})

test("high_mixed_score >= 0.6 + high_coverage >= 0.8 → needs_split_review", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.85,
    mixed_topic_score: 0.65,
    dominant_topic_share: 0.4,
  })
  assert.equal(result.family_kind, "needs_split_review")
  assert.equal(result.needs_human_review, true)
  assert.deepEqual(result.review_reasons, ["high_topic_mixedness"])
})

test("mixed_score >= 0.6 but coverage < 0.8 → does not trigger needs_split_review", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.7,
    mixed_topic_score: 0.65,
    dominant_topic_share: 0.5,
  })
  // Should fall through to unclear
  assert.equal(result.family_kind, "unclear")
  assert.equal(result.needs_human_review, true)
})

test("dominant_topic_share >= 0.75 → coherent_single_issue + no review", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.15,
    dominant_topic_share: 0.8,
  })
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, false)
  assert.deepEqual(result.review_reasons, [])
})

test("dominant_topic_share < 0.75 + other signals mixed → unclear + needs review", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.85,
    mixed_topic_score: 0.45,
    dominant_topic_share: 0.7,
  })
  assert.equal(result.family_kind, "unclear")
  assert.equal(result.needs_human_review, true)
  assert.deepEqual(result.review_reasons, ["mixed_or_unclear_signals"])
})

test("balanced distribution (dominant_topic_share=0.5) → unclear + needs review", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.5,
    dominant_topic_share: 0.5,
  })
  assert.equal(result.family_kind, "unclear")
  assert.equal(result.needs_human_review, true)
})

test("rule precedence: low_coverage checked first (before mixed_topic)", () => {
  // Even with high mixed score and coverage, low coverage should win
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.3,
    mixed_topic_score: 0.8,
    dominant_topic_share: 0.5,
  })
  assert.equal(result.family_kind, "low_evidence")
  assert.equal(result.needs_human_review, true)
})

test("rule precedence: needs_split_review checked before dominant_topic", () => {
  // High mixed score with high coverage should win over dominant_topic_share < 0.75
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.8,
    mixed_topic_score: 0.7,
    dominant_topic_share: 0.6,
  })
  assert.equal(result.family_kind, "needs_split_review")
  assert.equal(result.needs_human_review, true)
})

test("boundary: mixed_topic_score exactly 0.6", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.8,
    mixed_topic_score: 0.6,
    dominant_topic_share: 0.5,
  })
  assert.equal(result.family_kind, "needs_split_review")
  assert.equal(result.needs_human_review, true)
})

test("boundary: dominant_topic_share exactly 0.75", () => {
  const result = classifyFamilyHeuristic({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.2,
    dominant_topic_share: 0.75,
  })
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, false)
})
