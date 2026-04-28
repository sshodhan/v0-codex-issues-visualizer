// Pure helpers shared by the read-only quality dashboard UI. Kept in a
// separate module so they can be unit-tested without React.

export type QualityBucket = "safe_to_trust" | "needs_review" | "input_problem"

export interface QualityRow {
  cluster_id: string
  quality_bucket: QualityBucket
  family_kind: string | null
  recommended_action: string
  review_reasons: string[]
  quality_reasons: string[]
  classification_coverage_share: number | null
  mixed_topic_score: number | null
  observation_count: number
  llm_status: string | null
  llm_model: string | null
  representative_count: number
  representative_preview: string[]
  common_matched_phrase_count: number
  common_matched_phrase_preview: string[]
  needs_human_review: boolean
  algorithm_version: string | null
  classified_at: string | null
  llm_classified_at: string | null
  updated_at: string | null
}

export interface QualitySummary {
  bucket_counts: Record<string, number>
}

export interface QualityResponse {
  summary?: Partial<QualitySummary>
  rows?: unknown[]
}

// LLM statuses that indicate the LLM step did NOT cleanly succeed. We
// accept multiple vocabularies because the source-of-truth has shifted
// over time: the route's typed enum uses "success"/"error"/"auth_error"/
// "needs_review"/"needs_human_review", but earlier writers used
// "succeeded"/"failed"/"skipped_*"/"low_confidence_fallback". Any
// status not in BAD_LLM_STATUSES (and any "succeeded"/"success") is
// treated as a clean run.
export const BAD_LLM_STATUSES: ReadonlySet<string> = new Set<string>([
  "failed",
  "error",
  "auth_error",
  "skipped_missing_api_key",
  "skipped_no_representatives",
  "low_confidence_fallback",
  "needs_review",
  "needs_human_review",
])

export function isBadLlmStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return BAD_LLM_STATUSES.has(status)
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

export function normalizeBucket(value: unknown): QualityBucket {
  if (value === "safe_to_trust" || value === "needs_review" || value === "input_problem") {
    return value
  }
  return "needs_review"
}

// Tolerates both the current API shape and any near-miss field renames
// (qualityBucket vs quality_bucket, etc.) so the dashboard does not
// silently zero out if the endpoint gets reshaped.
export function normalizeQualityRow(input: unknown): QualityRow | null {
  if (!input || typeof input !== "object") return null
  const r = input as Record<string, unknown>
  const cluster_id = asString(r.cluster_id) ?? asString(r.clusterId)
  if (!cluster_id) return null
  return {
    cluster_id,
    quality_bucket: normalizeBucket(r.quality_bucket ?? r.qualityBucket),
    family_kind: asString(r.family_kind) ?? asString(r.familyKind),
    recommended_action:
      asString(r.recommended_action) ?? asString(r.recommendedAction) ?? "",
    review_reasons: asStringArray(r.review_reasons ?? r.reviewReasons),
    quality_reasons: asStringArray(r.quality_reasons ?? r.qualityReasons),
    classification_coverage_share: asNumber(
      r.classification_coverage_share ?? r.classificationCoverageShare,
    ),
    mixed_topic_score: asNumber(r.mixed_topic_score ?? r.mixedTopicScore),
    observation_count: asNumber(r.observation_count ?? r.observationCount) ?? 0,
    llm_status: asString(r.llm_status) ?? asString(r.llmStatus),
    llm_model: asString(r.llm_model) ?? asString(r.llmModel),
    representative_count: asNumber(r.representative_count ?? r.representativeCount) ?? 0,
    representative_preview: asStringArray(r.representative_preview ?? r.representativePreview),
    common_matched_phrase_count:
      asNumber(r.common_matched_phrase_count ?? r.commonMatchedPhraseCount) ?? 0,
    common_matched_phrase_preview: asStringArray(
      r.common_matched_phrase_preview ?? r.commonMatchedPhrasePreview,
    ),
    needs_human_review: r.needs_human_review === true || r.needsHumanReview === true,
    algorithm_version: asString(r.algorithm_version) ?? asString(r.algorithmVersion),
    classified_at: asString(r.classified_at) ?? asString(r.classifiedAt),
    llm_classified_at: asString(r.llm_classified_at) ?? asString(r.llmClassifiedAt),
    updated_at: asString(r.updated_at) ?? asString(r.updatedAt),
  }
}

// Falls back to recomputing bucket counts from rows when the server
// summary is missing or partial. Empty cards driven by a schema
// mismatch are worse than no dashboard.
export function deriveBucketCounts(
  summary: Partial<QualitySummary> | undefined,
  rows: QualityRow[],
): Record<string, number> {
  const fromServer = summary?.bucket_counts
  if (fromServer && typeof fromServer === "object") {
    const hasAny = Object.values(fromServer).some((v) => typeof v === "number")
    if (hasAny) return fromServer
  }
  const counts: Record<string, number> = {}
  for (const r of rows) {
    counts[r.quality_bucket] = (counts[r.quality_bucket] ?? 0) + 1
  }
  return counts
}

export type BucketFilter = "all" | QualityBucket

export function filterRowsByBucket(
  rows: QualityRow[],
  bucket: BucketFilter,
): QualityRow[] {
  if (bucket === "all") return rows
  return rows.filter((r) => r.quality_bucket === bucket)
}
