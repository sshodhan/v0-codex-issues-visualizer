// Validation + helper module for Family Classification QA Reviews.
//
// Pure functions only — no Supabase, no React, no fetch. The API route
// (app/api/admin/family-classification/review/route.ts) and the UI
// (components/admin/family-classification-panel.tsx) both consume these
// helpers, and the tests in tests/family-classification-review.test.ts
// drive them directly.
//
// What this module owns:
//   * the canonical lists of allowed verdicts / error layers /
//     error reasons / family kinds / quality buckets (kept in sync with
//     the CHECK constraints in scripts/030_family_classification_reviews.sql);
//   * a `validateFamilyClassificationReviewInput` that the POST route
//     calls before insert, so the 400 error messages match exactly what
//     the UI form would have prevented;
//   * a bounded `buildFamilyReviewEvidenceSnapshot` so the JSONB column
//     captures what the reviewer saw without dragging the entire LLM
//     payload along for the ride.
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

export const ERROR_LAYERS = [
  "layer_0_topic",
  "layer_a_cluster",
  "family_classification",
  "representatives",
  "llm_enrichment",
  "data_quality",
  "unknown",
] as const
export type ErrorLayer = (typeof ERROR_LAYERS)[number]

export const ERROR_REASONS = [
  "wrong_family_kind",
  "bad_family_title",
  "bad_family_summary",
  "bad_representatives",
  "bad_cluster_membership",
  "low_layer0_coverage",
  "wrong_layer0_topic_distribution",
  "llm_hallucinated",
  "llm_too_generic",
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
export function isErrorLayer(value: unknown): value is ErrorLayer {
  return typeof value === "string" && (ERROR_LAYERS as readonly string[]).includes(value)
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
  expectedFamilyKind?: unknown
  actualFamilyKind?: unknown
  qualityBucket?: unknown
  errorLayer?: unknown
  errorReason?: unknown
  notes?: unknown
  reviewedBy?: unknown
  evidenceSnapshot?: unknown
}

export interface FamilyClassificationReviewInputValid {
  classification_id: string
  cluster_id: string
  review_verdict: ReviewVerdict
  expected_family_kind: FamilyKind | null
  actual_family_kind: string | null
  quality_bucket: QualityBucket | null
  error_layer: ErrorLayer | null
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
// Rules (mirrored in the UI form):
//   * classificationId, clusterId, reviewVerdict are always required.
//   * verdict = "correct": error_layer/error_reason ignored
//     (forced to null on the way in so a misclick doesn't poison
//     downstream summaries).
//   * verdict = "incorrect": error_layer AND error_reason required.
//   * verdict = "incorrect" AND error_reason = "wrong_family_kind":
//     expected_family_kind also required.
//   * verdict = "unclear": notes optional but nothing else required.
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

  let errorLayer: ErrorLayer | null = null
  if (input.errorLayer != null && input.errorLayer !== "") {
    if (!isErrorLayer(input.errorLayer)) {
      errors.push(
        `errorLayer must be one of: ${ERROR_LAYERS.join(", ")}`,
      )
    } else {
      errorLayer = input.errorLayer
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

  // Verdict-specific cross-field rules. Run only after the verdict
  // itself parsed cleanly — otherwise the user gets two errors for
  // the same root cause.
  if (isReviewVerdict(verdict)) {
    if (verdict === "correct") {
      // Force-clear error fields on a correct verdict; a misclick on
      // the form should not pollute the by_error_layer summary.
      errorLayer = null
      errorReason = null
    } else if (verdict === "incorrect") {
      if (!errorLayer) errors.push("errorLayer is required for incorrect verdicts")
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
  }

  if (errors.length > 0) return { ok: false, errors }

  const evidenceSnapshot = asPlainRecord(input.evidenceSnapshot)

  return {
    ok: true,
    value: {
      classification_id: classificationId!,
      cluster_id: clusterId!,
      review_verdict: verdict as ReviewVerdict,
      expected_family_kind: expectedFamilyKind,
      actual_family_kind: actualFamilyKind,
      quality_bucket: qualityBucket,
      error_layer: errorLayer,
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
function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
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

  // Drop nulls/empty-strings/empty-arrays from the top-level snapshot
  // to keep the JSONB body tight; consumers should not rely on field
  // presence as a signal anyway.
  for (const key of Object.keys(snapshot)) {
    const v = snapshot[key]
    if (v === null) delete snapshot[key]
    else if (Array.isArray(v) && v.length === 0) delete snapshot[key]
  }
  // suppress unused-helper warning when none of the booleans are set
  void asBool

  return snapshot
}

// ---------------------------------------------------------------------
// Read-side helpers used by the GET /api/admin/family-classification/review
// endpoint and the dashboard summary card.
// ---------------------------------------------------------------------

export interface FamilyReviewSummaryRow {
  review_verdict: string | null
  quality_bucket: string | null
  error_layer: string | null
  error_reason: string | null
}

export interface FamilyReviewSummary {
  reviewed_count: number
  correct_count: number
  incorrect_count: number
  unclear_count: number
  by_quality_bucket: Record<string, { reviewed: number; correct: number; incorrect: number; unclear: number }>
  by_error_layer: Record<string, number>
  by_error_reason: Record<string, number>
  safe_to_trust_reviewed: number
  safe_to_trust_correct: number
  safe_to_trust_precision: number | null
  needs_review_reviewed: number
  needs_review_correct: number
  input_problem_reviewed: number
  input_problem_confirmed: number
  top_error_layer: string | null
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
export function summarizeFamilyReviewRows(
  rows: FamilyReviewSummaryRow[],
): FamilyReviewSummary {
  let reviewed = 0
  let correct = 0
  let incorrect = 0
  let unclear = 0
  const byBucket: FamilyReviewSummary["by_quality_bucket"] = {}
  const byLayer: Record<string, number> = {}
  const byReason: Record<string, number> = {}

  let safeToTrustReviewed = 0
  let safeToTrustCorrect = 0
  let needsReviewReviewed = 0
  let needsReviewCorrect = 0
  let inputProblemReviewed = 0
  let inputProblemConfirmed = 0

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

    if (row.error_layer) {
      byLayer[row.error_layer] = (byLayer[row.error_layer] ?? 0) + 1
    }
    if (row.error_reason) {
      byReason[row.error_reason] = (byReason[row.error_reason] ?? 0) + 1
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
    by_error_layer: byLayer,
    by_error_reason: byReason,
    safe_to_trust_reviewed: safeToTrustReviewed,
    safe_to_trust_correct: safeToTrustCorrect,
    safe_to_trust_precision:
      safeToTrustReviewed > 0 ? safeToTrustCorrect / safeToTrustReviewed : null,
    needs_review_reviewed: needsReviewReviewed,
    needs_review_correct: needsReviewCorrect,
    input_problem_reviewed: inputProblemReviewed,
    input_problem_confirmed: inputProblemConfirmed,
    top_error_layer: topEntry(byLayer),
    top_error_reason: topEntry(byReason),
  }
}
