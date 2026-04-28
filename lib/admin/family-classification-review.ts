// Validation + helper module for Family Classification QA Reviews.
//
// Pure functions only — no Supabase, no React, no fetch. The API route
// (app/api/admin/family-classification/review/route.ts) and the UI
// (components/admin/family-classification-panel.tsx) both consume these
// helpers, and the tests in tests/family-classification-review.test.ts
// drive them directly.
//
// What this module owns:
//   * the canonical lists of allowed verdicts / review decisions /
//     error sources (5-stage pipeline vocabulary) / error reasons /
//     family kinds / quality buckets (kept in sync with the CHECK
//     constraints in scripts/030_family_classification_reviews.sql);
//   * a `validateFamilyClassificationReviewInput` that the POST route
//     calls before insert, so the 400 error messages match exactly what
//     the UI form would have prevented;
//   * a bounded `buildFamilyReviewEvidenceSnapshot` so the JSONB column
//     captures what the reviewer saw (including the heuristic-vs-LLM
//     tie-break context) without dragging the entire LLM payload along
//     for the ride.
//
// What this module does NOT do:
//   * mutate `family_classifications` or `clusters` (reviews are
//     append-only, classifier output is unchanged);
//   * compute or change `quality_bucket` (that lives in
//     `lib/admin/family-classification-quality.ts`);
//   * decide whether a review is "actionable" — there is no ticketing
//     workflow.

export const REVIEW_VERDICTS = ["correct", "incorrect", "unclear"] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

// Tie-break decisions captured when heuristic and LLM disagree (or the
// row is otherwise flagged for human review). Independent of verdict —
// a reviewer can record a decision on a "correct" row to confirm the
// heuristic was right, or on an "incorrect" row to point at the LLM.
export const REVIEW_DECISIONS = [
  "accept_heuristic",
  "accept_llm",
  "override_family_kind",
  "mark_low_evidence",
  "mark_general_feedback",
  "needs_more_examples",
  "should_split_cluster",
  "not_actionable",
] as const
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

// Stage vocabulary aligned with PR #162's 5-stage classification
// pipeline framing. `representative_selection` and `data_quality` are
// cross-stage error sources that don't map cleanly to a single stage.
export const ERROR_SOURCES = [
  "stage_1_regex_topic",
  "stage_2_embedding",
  "stage_3_clustering",
  "stage_4_llm_classification",
  "stage_4_family_naming",
  "stage_4_fallback",
  "stage_5_review_workflow",
  "representative_selection",
  "data_quality",
  "unknown",
] as const
export type ErrorSource = (typeof ERROR_SOURCES)[number]

export const ERROR_REASONS = [
  "wrong_family_kind",
  "bad_family_title",
  "bad_family_summary",
  "bad_representatives",
  "bad_cluster_membership",
  "llm_hallucinated",
  "llm_too_generic",
  // Tie-break specific reasons — capture what went wrong when
  // heuristic and LLM disagreed.
  "heuristic_overrode_better_llm_answer",
  "llm_disagreed_but_was_wrong",
  "low_evidence_should_not_be_coherent",
  "general_feedback_not_actionable",
  "singleton_not_recurring",
  "mixed_cluster_should_split",
  "false_safe_to_trust",
  "false_needs_review",
  "false_input_problem",
  "other",
] as const
export type ErrorReason = (typeof ERROR_REASONS)[number]

export const FAMILY_KIND_VALUES = [
  "coherent_single_issue",
  "mixed_multi_causal",
  "needs_split_review",
  "low_evidence",
  "unclear",
] as const
export type FamilyKind = (typeof FAMILY_KIND_VALUES)[number]

export const QUALITY_BUCKET_VALUES = [
  "safe_to_trust",
  "needs_review",
  "input_problem",
] as const
export type QualityBucket = (typeof QUALITY_BUCKET_VALUES)[number]

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return typeof value === "string" && (REVIEW_VERDICTS as readonly string[]).includes(value)
}
export function isReviewDecision(value: unknown): value is ReviewDecision {
  return typeof value === "string" && (REVIEW_DECISIONS as readonly string[]).includes(value)
}
export function isErrorSource(value: unknown): value is ErrorSource {
  return typeof value === "string" && (ERROR_SOURCES as readonly string[]).includes(value)
}
export function isErrorReason(value: unknown): value is ErrorReason {
  return typeof value === "string" && (ERROR_REASONS as readonly string[]).includes(value)
}
export function isFamilyKind(value: unknown): value is FamilyKind {
  return typeof value === "string" && (FAMILY_KIND_VALUES as readonly string[]).includes(value)
}
export function isQualityBucket(value: unknown): value is QualityBucket {
  return typeof value === "string" && (QUALITY_BUCKET_VALUES as readonly string[]).includes(value)
}

export interface FamilyClassificationReviewInputRaw {
  classificationId?: unknown
  clusterId?: unknown
  reviewVerdict?: unknown
  reviewDecision?: unknown
  expectedFamilyKind?: unknown
  actualFamilyKind?: unknown
  // Optional context input — not stored in its own column. The validator
  // uses it to enforce the tie-break contract (`correct + accept_llm` is
  // rejected on disagreement rows, see Stage 5 review contract in
  // docs/CLUSTERING_DESIGN.md §5.2). Origin: the LLM's suggested
  // family_kind from `evidence.llm.suggested_family_kind` on the
  // classification row, surfaced through the quality route. Lands in
  // `evidence_snapshot.tie_break_context.llm_suggested_family_kind`.
  llmSuggestedFamilyKind?: unknown
  qualityBucket?: unknown
  errorSource?: unknown
  errorReason?: unknown
  notes?: unknown
  reviewedBy?: unknown
  evidenceSnapshot?: unknown
}

export interface FamilyClassificationReviewInputValid {
  classification_id: string
  cluster_id: string
  review_verdict: ReviewVerdict
  review_decision: ReviewDecision | null
  expected_family_kind: FamilyKind | null
  actual_family_kind: string | null
  quality_bucket: QualityBucket | null
  error_source: ErrorSource | null
  error_reason: ErrorReason | null
  notes: string | null
  reviewed_by: string | null
  evidence_snapshot: Record<string, unknown>
}

export type ValidationResult =
  | { ok: true; value: FamilyClassificationReviewInputValid }
  | { ok: false; errors: string[] }

const NOTES_MAX_LENGTH = 4000

function trimToString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

// Validates a raw POST body. Centralised here so the API route's 400
// messages match the UI guards exactly (and so the tests can drive
// the same validator without spinning up a Next request).
//
// The tie-break contract (Stage 5 → Stage 4 feedback). See
// docs/CLUSTERING_DESIGN.md §5.2 "Stage 5 review contract" for the
// motivation and consumer (Improvement Workbench, #164).
//
// `review_verdict` answers: is the current stored/displayed
//                          classification acceptable?
// `review_decision` answers: how did the human resolve the tie or
//                            uncertainty?
// `error_source` answers: which Stage / root cause should be improved?
//
// Hard rules (enforced here so the data the Improvement Workbench
// reads back is unambiguous):
//   * classificationId, clusterId, reviewVerdict are always required.
//   * verdict = "correct": error_source/error_reason ignored
//     (forced to null on the way in so a misclick doesn't poison
//     downstream summaries).
//   * verdict = "incorrect": error_source AND error_reason required.
//   * verdict = "incorrect" AND error_reason = "wrong_family_kind":
//     expected_family_kind also required.
//   * verdict = "unclear": notes optional, error fields optional.
//     Designed to support `unclear + needs_more_examples` without
//     forcing a fake error_source.
//   * review_decision = "override_family_kind" (independent of
//     verdict): expected_family_kind required.
//   * review_decision = "mark_low_evidence" (independent of verdict):
//     expected_family_kind defaults to "low_evidence" when unset.
//   * review_decision = "should_split_cluster" (independent of
//     verdict): error_source defaults to "stage_3_clustering" when
//     unset; if explicitly set, must be one of
//     {stage_3_clustering, representative_selection} — those are the
//     only places a reviewer actionably blames a split decision.
//   * verdict = "correct" AND review_decision = "accept_llm":
//     REJECTED when the LLM disagreed with the heuristic
//     (llmSuggestedFamilyKind != null && != actualFamilyKind).
//     Rationale: "stored output is acceptable AND the LLM is the
//     better signal" only makes sense when the two suggested the
//     same kind (LLM is a stronger rationale, heuristic happened to
//     match). When they disagreed, "accept_llm" implies the stored
//     output is wrong → verdict must be "incorrect", not "correct".
//     Without this rule the Improvement Workbench can't tell which
//     side the human picked.
//   * notes capped at NOTES_MAX_LENGTH so the JSONB row doesn't blow
//     up if a reviewer pastes an entire chat transcript.
export function validateFamilyClassificationReviewInput(
  input: FamilyClassificationReviewInputRaw,
): ValidationResult {
  const errors: string[] = []

  const classificationId = trimToString(input.classificationId)
  const clusterId = trimToString(input.clusterId)
  const verdict = input.reviewVerdict
  const reviewedBy = trimToString(input.reviewedBy)

  if (!classificationId) errors.push("classificationId is required")
  if (!clusterId) errors.push("clusterId is required")
  if (!isReviewVerdict(verdict)) {
    errors.push(
      `reviewVerdict must be one of: ${REVIEW_VERDICTS.join(", ")}`,
    )
  }

  let reviewDecision: ReviewDecision | null = null
  if (input.reviewDecision != null && input.reviewDecision !== "") {
    if (!isReviewDecision(input.reviewDecision)) {
      errors.push(
        `reviewDecision must be one of: ${REVIEW_DECISIONS.join(", ")}`,
      )
    } else {
      reviewDecision = input.reviewDecision
    }
  }

  // Optional fields that, when provided, must be from a valid set.
  let expectedFamilyKind: FamilyKind | null = null
  if (input.expectedFamilyKind != null && input.expectedFamilyKind !== "") {
    if (!isFamilyKind(input.expectedFamilyKind)) {
      errors.push(
        `expectedFamilyKind must be one of: ${FAMILY_KIND_VALUES.join(", ")}`,
      )
    } else {
      expectedFamilyKind = input.expectedFamilyKind
    }
  }

  const actualFamilyKindRaw = trimToString(input.actualFamilyKind)
  // We do not constrain actualFamilyKind to FAMILY_KIND_VALUES because
  // a future classifier version might emit a value the reviewer module
  // does not know yet; storing the literal string is the audit-safe
  // behavior. Empty strings collapse to null so summaries don't gain
  // a synthetic "" bucket.
  const actualFamilyKind = actualFamilyKindRaw

  // llmSuggestedFamilyKind is validation-only — it lands in
  // evidence_snapshot.tie_break_context, not its own column. Loose
  // typing for the same forward-compat reason as actualFamilyKind.
  const llmSuggestedFamilyKind = trimToString(input.llmSuggestedFamilyKind)

  let qualityBucket: QualityBucket | null = null
  if (input.qualityBucket != null && input.qualityBucket !== "") {
    if (!isQualityBucket(input.qualityBucket)) {
      errors.push(
        `qualityBucket must be one of: ${QUALITY_BUCKET_VALUES.join(", ")}`,
      )
    } else {
      qualityBucket = input.qualityBucket
    }
  }

  let errorSource: ErrorSource | null = null
  if (input.errorSource != null && input.errorSource !== "") {
    if (!isErrorSource(input.errorSource)) {
      errors.push(
        `errorSource must be one of: ${ERROR_SOURCES.join(", ")}`,
      )
    } else {
      errorSource = input.errorSource
    }
  }

  let errorReason: ErrorReason | null = null
  if (input.errorReason != null && input.errorReason !== "") {
    if (!isErrorReason(input.errorReason)) {
      errors.push(
        `errorReason must be one of: ${ERROR_REASONS.join(", ")}`,
      )
    } else {
      errorReason = input.errorReason
    }
  }

  let notes: string | null = trimToString(input.notes)
  if (notes && notes.length > NOTES_MAX_LENGTH) {
    notes = notes.slice(0, NOTES_MAX_LENGTH)
  }

  // review_decision cross-field rules. Run BEFORE the verdict-specific
  // requirements so decision-driven defaults (e.g.
  // should_split_cluster → stage_3_clustering) populate fields the
  // verdict block then validates. Independent of verdict so a reviewer
  // can record a tie-break decision on a "correct" row too.
  if (reviewDecision === "override_family_kind" && !expectedFamilyKind) {
    errors.push(
      "expectedFamilyKind is required when reviewDecision = override_family_kind",
    )
  }
  if (reviewDecision === "mark_low_evidence" && !expectedFamilyKind) {
    // Implicit: marking the row as low-evidence means the reviewer
    // believes that's what the family_kind should have been.
    expectedFamilyKind = "low_evidence"
  }
  if (reviewDecision === "should_split_cluster") {
    // The only actionable Stage when a family should split is upstream
    // — either Stage 3 grouped two distinct issues into one cluster,
    // or representative selection over-weighted one of them. Default
    // to stage_3_clustering when unset; otherwise constrain.
    if (!errorSource) {
      errorSource = "stage_3_clustering"
    } else if (
      errorSource !== "stage_3_clustering" &&
      errorSource !== "representative_selection"
    ) {
      errors.push(
        "errorSource must be stage_3_clustering or representative_selection when reviewDecision = should_split_cluster",
      )
    }
  }

  // Verdict-specific cross-field rules. Run only after the verdict
  // itself parsed cleanly — otherwise the user gets two errors for
  // the same root cause.
  if (isReviewVerdict(verdict)) {
    if (verdict === "correct") {
      // Force-clear error fields on a correct verdict; a misclick on
      // the form should not pollute the by_error_source summary.
      errorSource = null
      errorReason = null
    } else if (verdict === "incorrect") {
      if (!errorSource) errors.push("errorSource is required for incorrect verdicts")
      if (!errorReason) errors.push("errorReason is required for incorrect verdicts")
      if (errorReason === "wrong_family_kind" && !expectedFamilyKind) {
        errors.push(
          "expectedFamilyKind is required when errorReason = wrong_family_kind",
        )
      }
    }
    // verdict === "unclear": notes are only recommended, not required.
    // Cross-field validation intentionally permissive here; downstream
    // summary helpers can flag "many unclear with no notes" later.
    // Critically: `unclear` does NOT require error_source/error_reason
    // so combinations like `unclear + needs_more_examples` work
    // without forcing a fake error.
  }
  // Tie-break contract: "correct" stored output cannot also "accept_llm"
  // when the LLM suggested a different family_kind. See validator
  // header for full rationale. We only flag when we have evidence the
  // two actually disagreed; if llmSuggestedFamilyKind isn't supplied
  // (older client, missing data) we leave the row alone rather than
  // refusing to record a review at all.
  if (
    isReviewVerdict(verdict) &&
    verdict === "correct" &&
    reviewDecision === "accept_llm" &&
    llmSuggestedFamilyKind &&
    actualFamilyKind &&
    llmSuggestedFamilyKind !== actualFamilyKind
  ) {
    errors.push(
      "reviewVerdict = correct with reviewDecision = accept_llm is not allowed when the LLM suggested a different family_kind than the stored one — pick reviewVerdict = incorrect instead",
    )
  }

  if (errors.length > 0) return { ok: false, errors }

  const evidenceSnapshot = asPlainRecord(input.evidenceSnapshot)

  return {
    ok: true,
    value: {
      classification_id: classificationId!,
      cluster_id: clusterId!,
      review_verdict: verdict as ReviewVerdict,
      review_decision: reviewDecision,
      expected_family_kind: expectedFamilyKind,
      actual_family_kind: actualFamilyKind,
      quality_bucket: qualityBucket,
      error_source: errorSource,
      error_reason: errorReason,
      notes,
      reviewed_by: reviewedBy,
      evidence_snapshot: evidenceSnapshot,
    },
  }
}

// Bounded preview helpers so the `evidence_snapshot` JSONB does not
// double as a place to store the full LLM payload.
const SNAPSHOT_REPRESENTATIVE_PREVIEW = 5
const SNAPSHOT_PHRASE_PREVIEW = 8
const SNAPSHOT_RATIONALE_MAX_CHARS = 1000

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : []
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export interface FamilyReviewEvidenceSnapshotInput {
  classification_id?: string | null
  cluster_id?: string | null
  family_title?: string | null
  family_summary?: string | null
  family_kind?: string | null
  quality_bucket?: string | null
  quality_reasons?: string[] | null
  recommended_action?: string | null
  confidence?: number | null
  needs_human_review?: boolean | null
  review_reasons?: string[] | null
  evidence?: Record<string, unknown> | null
  representative_count?: number | null
  representative_preview?: string[] | null
  common_matched_phrase_count?: number | null
  common_matched_phrase_preview?: string[] | null
  // The reviewer's tie-break decision, if any. Captured so the snapshot
  // records "what did they have on screen, and which side did they pick?"
  // alongside the review_decision column on the table itself.
  review_decision?: ReviewDecision | null
  // LLM's suggested family kind, if known. The heuristic's stored
  // family_kind on the row is compared against this to derive the
  // tie_break_context block. Falls back to evidence.llm.suggested_family_kind
  // when omitted.
  llm_suggested_family_kind?: string | null
}

// Builds the JSONB body the API stores alongside each review. Goal:
// freeze enough context for an audit ("did the reviewer have the LLM
// rationale on screen when they marked this incorrect?") without
// keeping the full per-cluster LLM payload, which can run kilobytes.
//
// Bounded fields:
//   * representative_preview: first SNAPSHOT_REPRESENTATIVE_PREVIEW titles
//   * common_matched_phrase_preview: first SNAPSHOT_PHRASE_PREVIEW phrases
//   * llm.rationale: truncated at SNAPSHOT_RATIONALE_MAX_CHARS
export function buildFamilyReviewEvidenceSnapshot(
  row: FamilyReviewEvidenceSnapshotInput | null | undefined,
): Record<string, unknown> {
  if (!row) return {}
  const evidence = asRecord(row.evidence) ?? {}
  const llm = asRecord(evidence.llm)
  const clusterTopicMetadata = asRecord(evidence.cluster_topic_metadata)

  const representativesFromEvidence = asArray(evidence.representatives)
  const representativeTitlesFromEvidence: string[] = []
  for (const rep of representativesFromEvidence) {
    const repRecord = asRecord(rep)
    const title = repRecord ? asString(repRecord.title) : null
    if (title) representativeTitlesFromEvidence.push(title)
  }

  const representativePreview =
    row.representative_preview && row.representative_preview.length > 0
      ? row.representative_preview
      : representativeTitlesFromEvidence
  const phrasePreview = row.common_matched_phrase_preview ?? []

  const rationaleRaw = llm ? asString(llm.rationale) : null
  const rationale =
    rationaleRaw && rationaleRaw.length > SNAPSHOT_RATIONALE_MAX_CHARS
      ? `${rationaleRaw.slice(0, SNAPSHOT_RATIONALE_MAX_CHARS)}…`
      : rationaleRaw

  const snapshot: Record<string, unknown> = {
    classification_id: row.classification_id ?? null,
    cluster_id: row.cluster_id ?? null,
    family_title: row.family_title ?? null,
    family_summary: row.family_summary ?? null,
    family_kind: row.family_kind ?? null,
    quality_bucket: row.quality_bucket ?? null,
    quality_reasons: asStringArray(row.quality_reasons),
    recommended_action: row.recommended_action ?? null,
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    needs_human_review:
      typeof row.needs_human_review === "boolean" ? row.needs_human_review : null,
    review_reasons: asStringArray(row.review_reasons),
    representative_count:
      typeof row.representative_count === "number"
        ? row.representative_count
        : representativesFromEvidence.length,
    representative_preview: representativePreview.slice(
      0,
      SNAPSHOT_REPRESENTATIVE_PREVIEW,
    ),
    common_matched_phrase_count:
      typeof row.common_matched_phrase_count === "number"
        ? row.common_matched_phrase_count
        : asArray(clusterTopicMetadata?.common_matched_phrases).length,
    common_matched_phrase_preview: phrasePreview.slice(
      0,
      SNAPSHOT_PHRASE_PREVIEW,
    ),
  }

  if (llm) {
    snapshot.llm = {
      status: asString(llm.status),
      suggested_family_kind: asString(llm.suggested_family_kind),
      rationale,
    }
  }

  if (clusterTopicMetadata) {
    snapshot.cluster_topic_metadata = {
      cluster_path: asString(clusterTopicMetadata.cluster_path),
      observation_count: asNumber(clusterTopicMetadata.observation_count),
      classification_coverage_share: asNumber(
        clusterTopicMetadata.classification_coverage_share,
      ),
      dominant_topic_slug: asString(clusterTopicMetadata.dominant_topic_slug),
      dominant_topic_share: asNumber(clusterTopicMetadata.dominant_topic_share),
      mixed_topic_score: asNumber(clusterTopicMetadata.mixed_topic_score),
      avg_confidence_proxy: asNumber(clusterTopicMetadata.avg_confidence_proxy),
      low_margin_count: asNumber(clusterTopicMetadata.low_margin_count),
      low_margin_share: asNumber(clusterTopicMetadata.low_margin_share),
    }
  }

  // Tie-break context: heuristic kind vs LLM suggestion + the reviewer's
  // chosen review_decision. Built whenever we have either side of the
  // comparison so a later analysis can answer "when heuristic and LLM
  // disagreed, which did the human pick?".
  const heuristicKind = row.family_kind ?? null
  const llmSuggestedKind =
    row.llm_suggested_family_kind ?? (llm ? asString(llm.suggested_family_kind) : null)
  const reviewDecision = row.review_decision ?? null
  if (heuristicKind || llmSuggestedKind || reviewDecision) {
    snapshot.tie_break_context = {
      heuristic_family_kind: heuristicKind,
      llm_suggested_family_kind: llmSuggestedKind,
      llm_disagrees:
        heuristicKind != null &&
        llmSuggestedKind != null &&
        heuristicKind !== llmSuggestedKind,
      review_decision: reviewDecision,
    }
  }

  // Drop nulls/empty-strings/empty-arrays from the top-level snapshot
  // to keep the JSONB body tight; consumers should not rely on field
  // presence as a signal anyway.
  for (const key of Object.keys(snapshot)) {
    const v = snapshot[key]
    if (v === null) delete snapshot[key]
    else if (Array.isArray(v) && v.length === 0) delete snapshot[key]
  }

  return snapshot
}

// ---------------------------------------------------------------------
// Read-side helpers used by the GET /api/admin/family-classification/review
// endpoint and the dashboard summary card.
// ---------------------------------------------------------------------

export interface FamilyReviewSummaryRow {
  review_verdict: string | null
  review_decision: string | null
  quality_bucket: string | null
  error_source: string | null
  error_reason: string | null
}

export interface FamilyReviewSummary {
  reviewed_count: number
  correct_count: number
  incorrect_count: number
  unclear_count: number
  by_quality_bucket: Record<string, { reviewed: number; correct: number; incorrect: number; unclear: number }>
  by_error_source: Record<string, number>
  by_error_reason: Record<string, number>
  by_review_decision: Record<string, number>
  safe_to_trust_reviewed: number
  safe_to_trust_correct: number
  safe_to_trust_precision: number | null
  needs_review_reviewed: number
  needs_review_correct: number
  input_problem_reviewed: number
  input_problem_confirmed: number
  // Tie-break outcome counts. tie_break_reviewed_count = total reviews
  // with any non-null review_decision (i.e. the reviewer engaged with
  // the tie-break flow); the per-decision counters below let the
  // dashboard render dedicated tiles without re-summing by_review_decision.
  // accept_heuristic + accept_llm specifically resolve a heuristic-vs-LLM
  // disagreement; the others record an outcome that doesn't pick a side.
  tie_break_reviewed_count: number
  heuristic_accepted_count: number
  llm_accepted_count: number
  override_family_kind_count: number
  low_evidence_override_count: number
  general_feedback_marked_count: number
  needs_more_examples_count: number
  should_split_cluster_count: number
  not_actionable_count: number
  top_error_source: string | null
  top_error_reason: string | null
}

// Reduces a list of latest-per-classification reviews into the
// summary tiles the dashboard renders. Pure so the same shape can be
// reused by the API and a future CSV export.
//
// Definitions:
//   * safe_to_trust_precision = correct / reviewed in safe_to_trust.
//     Directional, not statistically significant — caller decides
//     when it has enough rows to render.
//   * input_problem_confirmed counts incorrect verdicts on rows the
//     dashboard had already flagged as input_problem (i.e. the
//     dashboard caught a real problem). A correct verdict on an
//     input_problem row arguably means the dashboard over-flagged,
//     but we report both rather than collapsing to a single ratio.
//   * heuristic_accepted_count / llm_accepted_count count human
//     resolutions of heuristic-vs-LLM disagreements. accept_heuristic
//     means the reviewer agreed with the heuristic's stored kind;
//     accept_llm means the reviewer agreed with the LLM's suggestion
//     and the heuristic was wrong. NB: a "correct + accept_llm" review
//     is intentional double-attribution — the reviewer is saying both
//     "the stored answer happened to be right" AND "the LLM's
//     suggestion was the better signal", e.g. when the heuristic and
//     LLM coincidentally agreed but only the LLM had a coherent reason.
//     The summary counts it under both `correct_count` and
//     `llm_accepted_count` on purpose; downstream consumers should not
//     try to deduplicate.
//   * override_family_kind_count / low_evidence_override_count etc.
//     are independent counts so the dashboard can render a tile per
//     decision without re-summing by_review_decision.
export function summarizeFamilyReviewRows(
  rows: FamilyReviewSummaryRow[],
): FamilyReviewSummary {
  let reviewed = 0
  let correct = 0
  let incorrect = 0
  let unclear = 0
  const byBucket: FamilyReviewSummary["by_quality_bucket"] = {}
  const bySource: Record<string, number> = {}
  const byReason: Record<string, number> = {}
  const byDecision: Record<string, number> = {}

  let safeToTrustReviewed = 0
  let safeToTrustCorrect = 0
  let needsReviewReviewed = 0
  let needsReviewCorrect = 0
  let inputProblemReviewed = 0
  let inputProblemConfirmed = 0
  let tieBreakReviewed = 0
  let heuristicAccepted = 0
  let llmAccepted = 0
  let overrideFamilyKind = 0
  let lowEvidenceOverride = 0
  let generalFeedbackMarked = 0
  let needsMoreExamples = 0
  let shouldSplitCluster = 0
  let notActionable = 0

  for (const row of rows) {
    reviewed += 1
    const verdict = row.review_verdict
    if (verdict === "correct") correct += 1
    else if (verdict === "incorrect") incorrect += 1
    else if (verdict === "unclear") unclear += 1

    if (row.quality_bucket) {
      const slot = byBucket[row.quality_bucket] ?? {
        reviewed: 0,
        correct: 0,
        incorrect: 0,
        unclear: 0,
      }
      slot.reviewed += 1
      if (verdict === "correct") slot.correct += 1
      else if (verdict === "incorrect") slot.incorrect += 1
      else if (verdict === "unclear") slot.unclear += 1
      byBucket[row.quality_bucket] = slot

      if (row.quality_bucket === "safe_to_trust") {
        safeToTrustReviewed += 1
        if (verdict === "correct") safeToTrustCorrect += 1
      } else if (row.quality_bucket === "needs_review") {
        needsReviewReviewed += 1
        if (verdict === "correct") needsReviewCorrect += 1
      } else if (row.quality_bucket === "input_problem") {
        inputProblemReviewed += 1
        if (verdict === "incorrect") inputProblemConfirmed += 1
      }
    }

    if (row.error_source) {
      bySource[row.error_source] = (bySource[row.error_source] ?? 0) + 1
    }
    if (row.error_reason) {
      byReason[row.error_reason] = (byReason[row.error_reason] ?? 0) + 1
    }
    if (row.review_decision) {
      byDecision[row.review_decision] = (byDecision[row.review_decision] ?? 0) + 1
      tieBreakReviewed += 1
      switch (row.review_decision) {
        case "accept_heuristic":
          heuristicAccepted += 1
          break
        case "accept_llm":
          llmAccepted += 1
          break
        case "override_family_kind":
          overrideFamilyKind += 1
          break
        case "mark_low_evidence":
          lowEvidenceOverride += 1
          break
        case "mark_general_feedback":
          generalFeedbackMarked += 1
          break
        case "needs_more_examples":
          needsMoreExamples += 1
          break
        case "should_split_cluster":
          shouldSplitCluster += 1
          break
        case "not_actionable":
          notActionable += 1
          break
      }
    }
  }

  const topEntry = (counts: Record<string, number>): string | null => {
    let bestKey: string | null = null
    let bestVal = -1
    for (const [k, v] of Object.entries(counts)) {
      if (v > bestVal) {
        bestVal = v
        bestKey = k
      }
    }
    return bestKey
  }

  return {
    reviewed_count: reviewed,
    correct_count: correct,
    incorrect_count: incorrect,
    unclear_count: unclear,
    by_quality_bucket: byBucket,
    by_error_source: bySource,
    by_error_reason: byReason,
    by_review_decision: byDecision,
    safe_to_trust_reviewed: safeToTrustReviewed,
    safe_to_trust_correct: safeToTrustCorrect,
    safe_to_trust_precision:
      safeToTrustReviewed > 0 ? safeToTrustCorrect / safeToTrustReviewed : null,
    needs_review_reviewed: needsReviewReviewed,
    needs_review_correct: needsReviewCorrect,
    input_problem_reviewed: inputProblemReviewed,
    input_problem_confirmed: inputProblemConfirmed,
    tie_break_reviewed_count: tieBreakReviewed,
    heuristic_accepted_count: heuristicAccepted,
    llm_accepted_count: llmAccepted,
    override_family_kind_count: overrideFamilyKind,
    low_evidence_override_count: lowEvidenceOverride,
    general_feedback_marked_count: generalFeedbackMarked,
    needs_more_examples_count: needsMoreExamples,
    should_split_cluster_count: shouldSplitCluster,
    not_actionable_count: notActionable,
    top_error_source: topEntry(bySource),
    top_error_reason: topEntry(byReason),
  }
}
