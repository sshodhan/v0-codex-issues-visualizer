import test from "node:test"
import assert from "node:assert/strict"

// Tests for the family classification heuristic. Imports the *exported*
// rule from lib/storage/family-classification.ts so production drift is
// caught — earlier versions of this file inlined a copy and silently
// passed when the real function diverged.

import {
  applyLlmDisagreement,
  classifyFamilyHeuristic,
  type HeuristicInput,
  type HeuristicResult,
} from "../lib/storage/family-classification.ts"

// Most tests pin only the few inputs they care about; defaults below
// keep the rest in the "coherent, semantic, confident" zone so we
// exercise one rule at a time.
const DEFAULT_INPUT: HeuristicInput = {
  classification_coverage_share: 0.9,
  mixed_topic_score: 0.2,
  dominant_topic_share: 0.5,
  low_margin_count: 0,
  observation_count: 100,
  cluster_path: "semantic",
  avg_confidence_proxy: 0.8,
}

function call(overrides: Partial<HeuristicInput> = {}): HeuristicResult {
  return classifyFamilyHeuristic({ ...DEFAULT_INPUT, ...overrides })
}

// ============================================================================
// Rule 1: low coverage → low_evidence
// ============================================================================

test("low_coverage < 0.5 → low_evidence + needs_human_review", () => {
  const result = call({
    classification_coverage_share: 0.3,
    mixed_topic_score: 0.2,
    dominant_topic_share: 0.8,
  })
  assert.equal(result.family_kind, "low_evidence")
  assert.equal(result.needs_human_review, true)
  assert.deepEqual(result.review_reasons, ["low_classification_coverage"])
})

test("coverage at 0.5 boundary is not low_evidence", () => {
  const result = call({
    classification_coverage_share: 0.5,
    mixed_topic_score: 0.1,
    dominant_topic_share: 0.8,
  })
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, false)
})

// ============================================================================
// Rule 2: mixed-topic branch (mixed_multi_causal vs needs_split_review)
// ============================================================================

test("high_mixed_score + high_coverage + low low-margin → mixed_multi_causal", () => {
  // Few close calls means Layer 0 is confident on each member; the
  // family is genuinely multi-causal, not a Layer 0 boundary problem.
  const result = call({
    classification_coverage_share: 0.85,
    mixed_topic_score: 0.65,
    dominant_topic_share: 0.4,
    low_margin_count: 5, // 5/100 = 5% < 40%
    observation_count: 100,
  })
  assert.equal(result.family_kind, "mixed_multi_causal")
  assert.equal(result.needs_human_review, false)
  assert.deepEqual(result.review_reasons, ["high_topic_mixedness"])
})

test("high_mixed_score + high_coverage + many close calls → needs_split_review", () => {
  // ≥ 40% low-margin members means Layer 0 itself is unsure where the
  // boundaries are. Escalates to needs_split_review.
  const result = call({
    classification_coverage_share: 0.85,
    mixed_topic_score: 0.65,
    dominant_topic_share: 0.4,
    low_margin_count: 50, // 50/100 = 50% ≥ 40%
    observation_count: 100,
  })
  assert.equal(result.family_kind, "needs_split_review")
  assert.equal(result.needs_human_review, true)
  assert.deepEqual(result.review_reasons, [
    "high_topic_mixedness",
    "many_close_topic_calls",
  ])
})

test("mixed_score >= 0.6 but coverage < 0.8 → falls through to unclear", () => {
  const result = call({
    classification_coverage_share: 0.7,
    mixed_topic_score: 0.65,
    dominant_topic_share: 0.5,
  })
  assert.equal(result.family_kind, "unclear")
  assert.equal(result.needs_human_review, true)
})

// ============================================================================
// Rule 3: high dominant share → coherent_single_issue
// ============================================================================

test("dominant_topic_share >= 0.75 → coherent_single_issue + no review", () => {
  const result = call({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.15,
    dominant_topic_share: 0.8,
  })
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, false)
  assert.deepEqual(result.review_reasons, [])
})

// ============================================================================
// Rule 4: fallthrough → unclear
// ============================================================================

test("dominant < 0.75 + low mixed → unclear + needs review", () => {
  const result = call({
    classification_coverage_share: 0.85,
    mixed_topic_score: 0.45,
    dominant_topic_share: 0.7,
  })
  assert.equal(result.family_kind, "unclear")
  assert.equal(result.needs_human_review, true)
  assert.deepEqual(result.review_reasons, ["mixed_or_unclear_signals"])
})

test("balanced distribution (dominant=0.5) → unclear + needs review", () => {
  const result = call({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.5,
    dominant_topic_share: 0.5,
  })
  assert.equal(result.family_kind, "unclear")
  assert.equal(result.needs_human_review, true)
})

// ============================================================================
// Rule precedence
// ============================================================================

test("rule precedence: low_coverage wins over high mixed score", () => {
  const result = call({
    classification_coverage_share: 0.3,
    mixed_topic_score: 0.8,
    dominant_topic_share: 0.5,
  })
  assert.equal(result.family_kind, "low_evidence")
})

test("rule precedence: mixed-topic branch wins over high dominant share", () => {
  // Even with dominant >= 0.75, if mixed >= 0.6 and coverage >= 0.8 we
  // take the mixed branch (Layer 0 says the family spans Topics).
  const result = call({
    classification_coverage_share: 0.8,
    mixed_topic_score: 0.7,
    dominant_topic_share: 0.6,
    low_margin_count: 5,
    observation_count: 100,
  })
  assert.equal(result.family_kind, "mixed_multi_causal")
})

// ============================================================================
// Boundary tests for the rule thresholds
// ============================================================================

test("boundary: mixed_topic_score exactly 0.6 enters mixed branch", () => {
  const result = call({
    classification_coverage_share: 0.8,
    mixed_topic_score: 0.6,
    dominant_topic_share: 0.5,
    low_margin_count: 5,
    observation_count: 100,
  })
  assert.equal(result.family_kind, "mixed_multi_causal")
})

test("boundary: dominant_topic_share exactly 0.75 → coherent", () => {
  const result = call({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.2,
    dominant_topic_share: 0.75,
  })
  assert.equal(result.family_kind, "coherent_single_issue")
})

test("boundary: low_margin_count at 40% exactly triggers split-review", () => {
  const result = call({
    classification_coverage_share: 0.85,
    mixed_topic_score: 0.65,
    dominant_topic_share: 0.4,
    low_margin_count: 40,
    observation_count: 100,
  })
  assert.equal(result.family_kind, "needs_split_review")
})

// ============================================================================
// Auxiliary signals (cluster_path, avg_confidence_proxy)
// ============================================================================

test("cluster_path=fallback adds review reason even when otherwise coherent", () => {
  const result = call({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.15,
    dominant_topic_share: 0.85,
    cluster_path: "fallback",
  })
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, true)
  assert.ok(result.review_reasons.includes("fallback_cluster_path"))
})

test("low avg_confidence_proxy adds review reason on coherent cluster", () => {
  const result = call({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.15,
    dominant_topic_share: 0.85,
    avg_confidence_proxy: 0.2,
  })
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, true)
  assert.ok(result.review_reasons.includes("low_avg_layer0_confidence"))
})

test("avg_confidence_proxy of null does not trigger the low-confidence reason", () => {
  const result = call({
    classification_coverage_share: 0.9,
    mixed_topic_score: 0.15,
    dominant_topic_share: 0.85,
    avg_confidence_proxy: null,
  })
  assert.equal(result.needs_human_review, false)
  assert.deepEqual(result.review_reasons, [])
})

test("aux signals are appended after primary review reasons (low_evidence path)", () => {
  const result = call({
    classification_coverage_share: 0.3,
    cluster_path: "fallback",
  })
  assert.equal(result.family_kind, "low_evidence")
  assert.deepEqual(result.review_reasons, [
    "low_classification_coverage",
    "fallback_cluster_path",
  ])
})

// ============================================================================
// observation_count = 0 edge case
// ============================================================================

test("zero observations does not divide-by-zero in low_margin_share", () => {
  const result = call({
    classification_coverage_share: 0.85,
    mixed_topic_score: 0.65,
    dominant_topic_share: 0.4,
    low_margin_count: 0,
    observation_count: 0,
  })
  // With observation_count=0, low_margin_share is treated as 0, so the
  // mixed branch picks mixed_multi_causal (not split_review).
  assert.equal(result.family_kind, "mixed_multi_causal")
})

// ============================================================================
// applyLlmDisagreement: heuristic stays authoritative
//
// These tests lock the v1 trust contract: the LLM's
// `suggested_family_kind` is a disagreement signal only. It can RAISE
// `needs_human_review` but it can never overwrite `family_kind` or
// downgrade an existing review requirement.
// ============================================================================

test("LLM disagreement does NOT overwrite heuristic family_kind", () => {
  const heuristic: HeuristicResult = {
    family_kind: "coherent_single_issue",
    needs_human_review: false,
    review_reasons: [],
  }
  const result = applyLlmDisagreement({
    heuristic,
    llm_suggested_family_kind: "needs_split_review",
  })
  // Heuristic's coherent_single_issue is preserved verbatim.
  assert.equal(result.family_kind, "coherent_single_issue")
  // But disagreement forces review.
  assert.equal(result.needs_human_review, true)
  assert.ok(result.review_reasons.includes("llm_disagrees_with_heuristic"))
})

test("LLM agreement leaves the heuristic verdict untouched", () => {
  const heuristic: HeuristicResult = {
    family_kind: "coherent_single_issue",
    needs_human_review: false,
    review_reasons: [],
  }
  const result = applyLlmDisagreement({
    heuristic,
    llm_suggested_family_kind: "coherent_single_issue",
  })
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, false)
  assert.deepEqual(result.review_reasons, [])
})

test("LLM null suggestion leaves the heuristic verdict untouched", () => {
  // Schema allows the model to decline the coherence judgement by
  // returning null. That is not disagreement and must not flip review.
  const heuristic: HeuristicResult = {
    family_kind: "coherent_single_issue",
    needs_human_review: false,
    review_reasons: [],
  }
  const result = applyLlmDisagreement({
    heuristic,
    llm_suggested_family_kind: null,
  })
  assert.equal(result.family_kind, "coherent_single_issue")
  assert.equal(result.needs_human_review, false)
  assert.deepEqual(result.review_reasons, [])
})

test("LLM disagreement cannot DOWNGRADE an existing needs_review", () => {
  // Heuristic already flagged the cluster for review (low_evidence). A
  // confident-coherent LLM suggestion must not silently suppress that.
  const heuristic: HeuristicResult = {
    family_kind: "low_evidence",
    needs_human_review: true,
    review_reasons: ["low_classification_coverage"],
  }
  const result = applyLlmDisagreement({
    heuristic,
    llm_suggested_family_kind: "coherent_single_issue",
  })
  assert.equal(result.family_kind, "low_evidence")
  assert.equal(result.needs_human_review, true)
  assert.deepEqual(result.review_reasons, [
    "low_classification_coverage",
    "llm_disagrees_with_heuristic",
  ])
})

test("LLM disagreement preserves existing review reasons in order", () => {
  const heuristic: HeuristicResult = {
    family_kind: "coherent_single_issue",
    needs_human_review: true,
    review_reasons: ["fallback_cluster_path", "low_avg_layer0_confidence"],
  }
  const result = applyLlmDisagreement({
    heuristic,
    llm_suggested_family_kind: "needs_split_review",
  })
  // Disagreement reason is appended at the end so existing reasons
  // keep their original ordering.
  assert.deepEqual(result.review_reasons, [
    "fallback_cluster_path",
    "low_avg_layer0_confidence",
    "llm_disagrees_with_heuristic",
  ])
})

test("applyLlmDisagreement does not mutate the input heuristic.review_reasons", () => {
  const reasons = ["low_classification_coverage"]
  const heuristic: HeuristicResult = {
    family_kind: "low_evidence",
    needs_human_review: true,
    review_reasons: reasons,
  }
  applyLlmDisagreement({
    heuristic,
    llm_suggested_family_kind: "coherent_single_issue",
  })
  // Original array is unchanged — caller's heuristic object is safe
  // to keep using.
  assert.deepEqual(reasons, ["low_classification_coverage"])
})
