export type FamilyQualityBucket = "safe_to_trust" | "needs_review" | "input_problem"

interface FamilyQualityFlags {
  // Input-problem flags (highest precedence).
  missingEvidence: boolean
  malformedEvidence: boolean
  missingRepresentatives: boolean
  missingCommonMatchedPhrases: boolean
  malformedRepresentatives: boolean
  malformedCommonMatchedPhrases: boolean
  malformedLlmStatus: boolean

  // Needs-review signals.
  llmNeedsReview: boolean
  llmErrored: boolean
  missingLlmStatus: boolean
  lowCoverage: boolean
  highMixedness: boolean
  fallbackClusterPath: boolean
  lowObservationCount: boolean
  existingNeedsHumanReview: boolean
  hasReviewReasons: boolean

  // Safe-to-trust strict criteria.
  strictCoveragePass: boolean
  strictMixednessPass: boolean
  strictPathPass: boolean
  strictObservationPass: boolean
  strictRepresentativePass: boolean
  strictPhrasePass: boolean
  strictLlmPass: boolean
  strictNoReviewSignalsPass: boolean
}

export interface FamilyQualityDecision {
  bucket: FamilyQualityBucket
  reasons: string[]
  recommendedAction: string
}

const COVERAGE_NEEDS_REVIEW_THRESHOLD = 0.55
const COVERAGE_SAFE_THRESHOLD = 0.8
const MIXEDNESS_NEEDS_REVIEW_THRESHOLD = 0.45
const MIXEDNESS_SAFE_THRESHOLD = 0.3
const OBSERVATION_SAFE_MIN = 5

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : []
}

function extractEvidence(row: unknown): Record<string, unknown> | null {
  const root = asRecord(row)
  if (!root) return null
  const evidence = root.evidence
  return asRecord(evidence)
}

function extractLlmStatus(evidence: Record<string, unknown> | null): string | null {
  if (!evidence) return null
  const llm = asRecord(evidence.llm)
  if (!llm) return null
  const status = llm.status
  return typeof status === "string" && status.trim() ? status.trim() : null
}

export function computeFamilyQualityFlags(row: unknown): FamilyQualityFlags {
  const base = asRecord(row)
  const evidence = extractEvidence(row)

  const representatives = asArray(evidence?.representatives)
  const phrases = asArray(evidence?.common_matched_phrases)

  const llmStatus = extractLlmStatus(evidence)
  const coverage = toFiniteNumber(base?.classification_coverage_share)
  const mixedness = toFiniteNumber(base?.mixed_topic_score)
  const observationCount = toFiniteNumber(base?.observation_count)
  const clusterPath = typeof base?.cluster_path === "string" ? base.cluster_path : null

  const reviewReasons = asArray(base?.review_reasons)
  const needsHumanReview = base?.needs_human_review === true

  const malformedRepresentatives =
    evidence !== null && !Array.isArray(evidence.representatives)
  const malformedCommonMatchedPhrases =
    evidence !== null && !Array.isArray(evidence.common_matched_phrases)
  const malformedLlmStatus =
    evidence !== null &&
    asRecord(evidence.llm) !== null &&
    evidence.llm !== null &&
    typeof asRecord(evidence.llm)?.status !== "undefined" &&
    typeof asRecord(evidence.llm)?.status !== "string"

  const llmNeedsReview =
    llmStatus === "needs_review" || llmStatus === "needs_human_review"
  const llmErrored = llmStatus === "error" || llmStatus === "auth_error"

  return {
    missingEvidence: evidence === null,
    malformedEvidence: evidence === null && base !== null && "evidence" in base,
    missingRepresentatives: representatives.length === 0,
    missingCommonMatchedPhrases: phrases.length === 0,
    malformedRepresentatives,
    malformedCommonMatchedPhrases,
    malformedLlmStatus,

    llmNeedsReview,
    llmErrored,
    missingLlmStatus: llmStatus === null,
    lowCoverage: coverage === null || coverage < COVERAGE_NEEDS_REVIEW_THRESHOLD,
    highMixedness: mixedness === null || mixedness >= MIXEDNESS_NEEDS_REVIEW_THRESHOLD,
    fallbackClusterPath: clusterPath === null || clusterPath === "fallback",
    lowObservationCount: observationCount === null || observationCount < OBSERVATION_SAFE_MIN,
    existingNeedsHumanReview: needsHumanReview,
    hasReviewReasons: reviewReasons.length > 0,

    strictCoveragePass: coverage !== null && coverage >= COVERAGE_SAFE_THRESHOLD,
    strictMixednessPass: mixedness !== null && mixedness < MIXEDNESS_SAFE_THRESHOLD,
    strictPathPass: clusterPath === "semantic",
    strictObservationPass: observationCount !== null && observationCount >= OBSERVATION_SAFE_MIN,
    strictRepresentativePass: representatives.length > 0,
    strictPhrasePass: phrases.length > 0,
    strictLlmPass:
      llmStatus !== null && llmStatus !== "error" && llmStatus !== "auth_error" && !llmNeedsReview,
    strictNoReviewSignalsPass: !needsHumanReview && reviewReasons.length === 0,
  }
}

export function computeFamilyQualityBucket(row: unknown): FamilyQualityDecision {
  const flags = computeFamilyQualityFlags(row)

  // 1) input_problem first.
  const inputReasons: string[] = []
  if (flags.missingEvidence) inputReasons.push("missing_evidence")
  if (flags.malformedRepresentatives) inputReasons.push("malformed_representatives")
  if (flags.malformedCommonMatchedPhrases) inputReasons.push("malformed_common_matched_phrases")
  if (flags.malformedLlmStatus) inputReasons.push("malformed_llm_status")

  if (inputReasons.length > 0) {
    return {
      bucket: "input_problem",
      reasons: inputReasons,
      recommendedAction:
        "Fix upstream evidence payload shape before trusting this family classification.",
    }
  }

  // 2) needs_review second.
  const reviewReasons: string[] = []
  if (flags.missingRepresentatives) reviewReasons.push("missing_representatives")
  if (flags.missingCommonMatchedPhrases) reviewReasons.push("missing_common_matched_phrases")
  if (flags.missingLlmStatus) reviewReasons.push("missing_llm_status")
  if (flags.llmNeedsReview) reviewReasons.push("llm_needs_review")
  if (flags.llmErrored) reviewReasons.push("llm_error")
  if (flags.lowCoverage) reviewReasons.push("low_classification_coverage")
  if (flags.highMixedness) reviewReasons.push("high_topic_mixedness")
  if (flags.fallbackClusterPath) reviewReasons.push("fallback_cluster_path")
  if (flags.lowObservationCount) reviewReasons.push("low_observation_count")
  if (flags.existingNeedsHumanReview) reviewReasons.push("existing_needs_human_review")
  if (flags.hasReviewReasons) reviewReasons.push("existing_review_reasons_present")

  if (reviewReasons.length > 0) {
    return {
      bucket: "needs_review",
      reasons: reviewReasons,
      recommendedAction:
        "Send to human review; verify representatives, topic evidence, and LLM status before accepting.",
    }
  }

  // 3) safe_to_trust only if strict criteria pass.
  const strictPass =
    flags.strictCoveragePass &&
    flags.strictMixednessPass &&
    flags.strictPathPass &&
    flags.strictObservationPass &&
    flags.strictRepresentativePass &&
    flags.strictPhrasePass &&
    flags.strictLlmPass &&
    flags.strictNoReviewSignalsPass

  if (strictPass) {
    return {
      bucket: "safe_to_trust",
      reasons: ["passes_strict_quality_criteria"],
      recommendedAction: "Safe to trust for downstream use without manual review.",
    }
  }

  return {
    bucket: "needs_review",
    reasons: ["does_not_meet_strict_safe_criteria"],
    recommendedAction:
      "Send to human review; strict trust criteria were not fully satisfied.",
  }
}
