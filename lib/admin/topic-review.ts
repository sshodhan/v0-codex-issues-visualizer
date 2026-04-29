// Admin Review Loop — shared constants + types for topic_review_events.
//
// The four enums (reason_code, suggested_stage, suggested_action, status)
// are mirrored into the CHECK constraints on topic_review_events
// (scripts/031_topic_review_events.sql). Keep them in lockstep — the
// contract test in tests/topic-review-contract.test.ts asserts the lists
// match across DB / API / UI.
//
// Vocabulary: this file uses the 5-stage classification improvement
// pipeline names (Stage 1 — regex / topic, Stage 2 — embeddings, Stage 3
// — clustering, Stage 4 — LLM classification + family, Stage 5 — human
// review). The DB column is still named `suggested_layer` for historical
// reasons (and to keep the migration small for this PR), but the values
// it carries are stage-named — `regex_topic`, `embedding`, `clustering`,
// `llm_classification_family`, `human_review_workflow`, `data_quality`,
// `unknown`. See docs/SCORING.md §11 and the column-name note in
// scripts/031_topic_review_events.sql.
//
// Do not embed UI copy here. The UI imports the labels map and builds its
// own dropdowns; the route imports the allowlists and validates input.

export const TOPIC_REVIEW_REASON_CODES = [
  "ambiguous_entity",
  "bad_family_cluster",
  "bad_family_label",
  // Stage-named "belongs to" reasons — the reviewer thinks the mistake's
  // root cause lives in a different stage of the pipeline.
  "belongs_to_clustering",
  "belongs_to_llm_classification_family",
  "known_limitation",
  "needs_new_guardrail",
  "other",
  "phrase_false_negative",
  "phrase_false_positive",
  "wrong_regex_topic",
] as const

export type TopicReviewReasonCode = (typeof TOPIC_REVIEW_REASON_CODES)[number]

// `suggested_layer` is the historical column name. The values are stage-
// named per the 5-stage model (PR #162). Renamed in this PR; the column
// itself was not renamed to keep the migration small.
export const TOPIC_REVIEW_SUGGESTED_LAYERS = [
  "clustering",
  "data_quality",
  "embedding",
  "human_review_workflow",
  "llm_classification_family",
  "regex_topic",
  "unknown",
] as const

export type TopicReviewSuggestedLayer =
  (typeof TOPIC_REVIEW_SUGGESTED_LAYERS)[number]

export const TOPIC_REVIEW_SUGGESTED_ACTIONS = [
  "add_golden_row",
  "consider_clustering_split_review",
  "consider_llm_taxonomy_update",
  "consider_phrase_addition",
  "consider_phrase_demotion",
  "consider_phrase_removal",
  "known_limitation_no_action",
  "manual_override_only",
  "none",
] as const

export type TopicReviewSuggestedAction =
  (typeof TOPIC_REVIEW_SUGGESTED_ACTIONS)[number]

export const TOPIC_REVIEW_STATUSES = [
  "accepted",
  "candidate",
  "exported",
  "new",
  "rejected",
  "resolved",
] as const

export type TopicReviewStatus = (typeof TOPIC_REVIEW_STATUSES)[number]

export function isReasonCode(value: unknown): value is TopicReviewReasonCode {
  return (
    typeof value === "string" &&
    (TOPIC_REVIEW_REASON_CODES as readonly string[]).includes(value)
  )
}

export function isSuggestedLayer(
  value: unknown,
): value is TopicReviewSuggestedLayer {
  return (
    typeof value === "string" &&
    (TOPIC_REVIEW_SUGGESTED_LAYERS as readonly string[]).includes(value)
  )
}

export function isSuggestedAction(
  value: unknown,
): value is TopicReviewSuggestedAction {
  return (
    typeof value === "string" &&
    (TOPIC_REVIEW_SUGGESTED_ACTIONS as readonly string[]).includes(value)
  )
}

export function isReviewStatus(value: unknown): value is TopicReviewStatus {
  return (
    typeof value === "string" &&
    (TOPIC_REVIEW_STATUSES as readonly string[]).includes(value)
  )
}

// Manual-override evidence shape persisted into category_assignments.evidence.
// The ORIGINAL deterministic assignment is preserved verbatim under
// `overridden_assignment` so an audit trail can always recover what the
// classifier actually said before the reviewer corrected it.
export interface ManualOverrideEvidence {
  override: true
  override_type: "topic"
  overridden_assignment: {
    algorithm_version: string | null
    category_id: string | null
    slug: string | null
    confidence: number | null
  }
  corrected: {
    category_id: string
    slug: string
  }
  reason_code: TopicReviewReasonCode
  suggested_layer: TopicReviewSuggestedLayer
  suggested_action: TopicReviewSuggestedAction
  rationale: string | null
  reviewer: string
  reviewed_at: string
}

export interface BuildOverrideEvidenceArgs {
  overriddenAssignment: {
    algorithmVersion: string | null
    categoryId: string | null
    slug: string | null
    confidence: number | null
  }
  corrected: { categoryId: string; slug: string }
  reasonCode: TopicReviewReasonCode
  suggestedLayer: TopicReviewSuggestedLayer
  suggestedAction: TopicReviewSuggestedAction
  rationale: string | null
  reviewer: string
  reviewedAt?: string
}

export function buildManualOverrideEvidence(
  args: BuildOverrideEvidenceArgs,
): ManualOverrideEvidence {
  return {
    override: true,
    override_type: "topic",
    overridden_assignment: {
      algorithm_version: args.overriddenAssignment.algorithmVersion,
      category_id: args.overriddenAssignment.categoryId,
      slug: args.overriddenAssignment.slug,
      confidence: args.overriddenAssignment.confidence,
    },
    corrected: {
      category_id: args.corrected.categoryId,
      slug: args.corrected.slug,
    },
    reason_code: args.reasonCode,
    suggested_layer: args.suggestedLayer,
    suggested_action: args.suggestedAction,
    rationale: args.rationale,
    reviewer: args.reviewer,
    reviewed_at: args.reviewedAt ?? new Date().toISOString(),
  }
}

export interface GoldenSetCandidate {
  title: string
  body: string
  expected: string
}

// Golden-set candidate row in the same shape used by
// tests/fixtures/topic-classifier-golden-set.csv consumers — { title,
// body, expected }. `expected` prefers the corrected slug; falls back to
// the current slug so a "manual_override_only" review (no correction) can
// still seed the file later.
export function buildGoldenSetCandidate(args: {
  title: string
  body: string
  correctedSlug: string | null
  currentSlug: string | null
}): GoldenSetCandidate | null {
  const expected = args.correctedSlug ?? args.currentSlug
  if (!expected) return null
  return {
    title: args.title,
    body: args.body,
    expected,
  }
}
