import test from "node:test"
import assert from "node:assert/strict"

import {
  computeFamilyQualityBucket,
  computeFamilyQualityFlags,
} from "../lib/admin/family-classification-quality.ts"

function makeBaseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    classification_coverage_share: 0.92,
    mixed_topic_score: 0.12,
    observation_count: 12,
    cluster_path: "semantic",
    needs_human_review: false,
    review_reasons: [],
    evidence: {
      representatives: ["rep-1"],
      common_matched_phrases: ["phrase-1"],
      llm: { status: "success" },
    },
    ...overrides,
  }
}

test("computeFamilyQualityBucket: no representatives => input_problem", () => {
  const decision = computeFamilyQualityBucket(
    makeBaseRow({ evidence: { representatives: [], common_matched_phrases: ["phrase-1"], llm: { status: "success" } } }),
  )

  assert.equal(decision.bucket, "input_problem")
  assert.ok(decision.reasons.includes("missing_representatives"))
})

test("computeFamilyQualityBucket: low coverage => input_problem", () => {
  const decision = computeFamilyQualityBucket(makeBaseRow({ classification_coverage_share: 0.2 }))

  assert.equal(decision.bucket, "input_problem")
  assert.ok(decision.reasons.includes("low_classification_coverage"))
})

test("computeFamilyQualityBucket: fallback cluster => input_problem", () => {
  const decision = computeFamilyQualityBucket(makeBaseRow({ cluster_path: "fallback" }))

  assert.equal(decision.bucket, "input_problem")
  assert.ok(decision.reasons.includes("fallback_cluster_path"))
})

test("computeFamilyQualityBucket: LLM disagreement => needs_review", () => {
  const decision = computeFamilyQualityBucket(
    makeBaseRow({ evidence: { representatives: ["rep-1"], common_matched_phrases: ["phrase-1"], llm: { status: "needs_review" } } }),
  )

  assert.equal(decision.bucket, "needs_review")
  assert.ok(decision.reasons.includes("llm_needs_review"))
})

test("computeFamilyQualityBucket: low confidence => needs_review", () => {
  const decision = computeFamilyQualityBucket(
    makeBaseRow({ evidence: { representatives: ["rep-1"], common_matched_phrases: ["phrase-1"], llm: { status: "low_confidence_fallback" } } }),
  )

  assert.equal(decision.bucket, "needs_review")
  assert.ok(decision.reasons.includes("llm_error"))
})

test("computeFamilyQualityBucket: high mixedness => needs_review", () => {
  const decision = computeFamilyQualityBucket(makeBaseRow({ mixed_topic_score: 0.6 }))

  assert.equal(decision.bucket, "needs_review")
  assert.ok(decision.reasons.includes("high_topic_mixedness"))
})

test("computeFamilyQualityBucket: clean semantic high-confidence row => safe_to_trust", () => {
  const decision = computeFamilyQualityBucket(makeBaseRow())

  assert.equal(decision.bucket, "safe_to_trust")
  assert.deepEqual(decision.reasons, ["passes_strict_quality_criteria"])
})

test("computeFamilyQualityFlags: llm failed", () => {
  const flags = computeFamilyQualityFlags(
    makeBaseRow({ evidence: { representatives: ["rep-1"], common_matched_phrases: ["phrase-1"], llm: { status: "failed" } } }),
  )

  assert.equal(flags.llmErrored, true)
})

test("computeFamilyQualityFlags: skipped missing api key", () => {
  const flags = computeFamilyQualityFlags(
    makeBaseRow({ evidence: { representatives: ["rep-1"], common_matched_phrases: ["phrase-1"], llm: { status: "skipped_missing_api_key" } } }),
  )

  assert.equal(flags.llmErrored, true)
  assert.equal(flags.strictLlmPass, false)
})

test("computeFamilyQualityFlags: skipped no representatives", () => {
  const flags = computeFamilyQualityFlags(
    makeBaseRow({ evidence: { representatives: ["rep-1"], common_matched_phrases: ["phrase-1"], llm: { status: "skipped_no_representatives" } } }),
  )

  assert.equal(flags.llmErrored, true)
  assert.equal(flags.strictLlmPass, false)
})

test("computeFamilyQualityFlags: low confidence fallback", () => {
  const flags = computeFamilyQualityFlags(
    makeBaseRow({ evidence: { representatives: ["rep-1"], common_matched_phrases: ["phrase-1"], llm: { status: "low_confidence_fallback" } } }),
  )

  assert.equal(flags.llmErrored, true)
  assert.equal(flags.strictLlmPass, false)
})

test("computeFamilyQualityFlags: missing body snippets", () => {
  const flags = computeFamilyQualityFlags(
    makeBaseRow({ evidence: { representatives: [], common_matched_phrases: ["phrase-1"], llm: { status: "success" } } }),
  )

  assert.equal(flags.missingRepresentatives, true)
  assert.equal(flags.strictRepresentativePass, false)
})

test("computeFamilyQualityFlags: no common phrases", () => {
  const flags = computeFamilyQualityFlags(
    makeBaseRow({ evidence: { representatives: ["rep-1"], common_matched_phrases: [], llm: { status: "success" } } }),
  )

  assert.equal(flags.missingCommonMatchedPhrases, true)
  assert.equal(flags.strictPhrasePass, false)
})

test("computeFamilyQualityFlags: malformed evidence safe defaults", () => {
  const flags = computeFamilyQualityFlags(makeBaseRow({ evidence: "bad-shape" }))

  assert.equal(flags.missingEvidence, true)
  assert.equal(flags.malformedEvidence, true)
  assert.equal(flags.missingRepresentatives, true)
  assert.equal(flags.missingCommonMatchedPhrases, true)
  assert.equal(flags.missingLlmStatus, true)
})

test("computeFamilyQualityFlags: numeric string coercion", () => {
  const flags = computeFamilyQualityFlags(
    makeBaseRow({
      classification_coverage_share: "0.81",
      mixed_topic_score: "0.29",
      observation_count: "6",
    }),
  )

  assert.equal(flags.strictCoveragePass, true)
  assert.equal(flags.strictMixednessPass, true)
  assert.equal(flags.strictObservationPass, true)
})
