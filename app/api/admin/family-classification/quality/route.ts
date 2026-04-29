import { NextRequest, NextResponse } from "next/server"
import { requireAdminSecret } from "@/lib/admin/auth"
import { computeFamilyQualityBucket, type FamilyQualityBucket } from "@/lib/admin/family-classification-quality"
import { createAdminClient } from "@/lib/supabase/admin"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SORT_OPTIONS = new Set(["updated_at_desc", "updated_at_asc", "observation_count_desc", "observation_count_asc", "coverage_desc", "coverage_asc", "mixedness_desc", "mixedness_asc"])
type LlmStatus = "success" | "needs_review" | "needs_human_review" | "error" | "auth_error" | null
interface QualityRow { classification_id: string | null; cluster_id: string; family_kind: string | null; family_title: string | null; family_summary: string | null; confidence: number | null; llm_status: LlmStatus; llm_suggested_family_kind: string | null; observation_count: number; classification_coverage_share: number | null; mixed_topic_score: number | null; quality_bucket: FamilyQualityBucket; quality_reasons: string[]; recommended_action: string; review_reasons: string[]; needs_human_review: boolean; representative_count: number; representative_preview: string[]; common_matched_phrase_count: number; common_matched_phrase_preview: string[]; algorithm_version: string | null; llm_model: string | null; llm_classified_at: string | null; classified_at: string | null; updated_at: string | null }

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}
const asRecord = (value: unknown): Record<string, unknown> | null => (!value || typeof value !== "object" || Array.isArray(value) ? null : (value as Record<string, unknown>))
const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter(Boolean) : [])
const parseLimit = (raw: string | null): number => {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(parsed, MAX_LIMIT))
}

function normalizeLlmStatus(row: Record<string, unknown>, evidence: Record<string, unknown> | null): LlmStatus {
  const top = typeof row.llm_status === "string" ? row.llm_status.trim() : ""
  if (top) return top as LlmStatus
  const llm = asRecord(evidence?.llm)
  const nested = typeof llm?.status === "string" ? llm.status.trim() : ""
  return nested ? (nested as LlmStatus) : null
}

function applyFilter(rows: QualityRow[], filter: string | null): QualityRow[] {
  const term = filter?.trim().toLowerCase()
  if (!term) return rows
  return rows.filter((r) => r.cluster_id.toLowerCase().includes(term) || (r.family_kind ?? "").toLowerCase().includes(term) || r.quality_bucket.includes(term) || r.quality_reasons.some((q) => q.toLowerCase().includes(term)) || r.review_reasons.some((q) => q.toLowerCase().includes(term)) || r.representative_preview.some((q) => q.toLowerCase().includes(term)) || r.common_matched_phrase_preview.some((q) => q.toLowerCase().includes(term)))
}

function sortRows(rows: QualityRow[], sort: string): QualityRow[] {
  const out = [...rows]
  switch (sort) {
    case "updated_at_asc": out.sort((a, b) => (a.updated_at ?? "").localeCompare(b.updated_at ?? "")); break
    case "observation_count_desc": out.sort((a, b) => b.observation_count - a.observation_count); break
    case "observation_count_asc": out.sort((a, b) => a.observation_count - b.observation_count); break
    case "coverage_desc": out.sort((a, b) => (b.classification_coverage_share ?? -1) - (a.classification_coverage_share ?? -1)); break
    case "coverage_asc": out.sort((a, b) => (a.classification_coverage_share ?? 2) - (b.classification_coverage_share ?? 2)); break
    case "mixedness_desc": out.sort((a, b) => (b.mixed_topic_score ?? -1) - (a.mixed_topic_score ?? -1)); break
    case "mixedness_asc": out.sort((a, b) => (a.mixed_topic_score ?? 2) - (b.mixed_topic_score ?? 2)); break
    default: out.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")); break
  }
  return out
}

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr
  const url = new URL(request.url)
  const limit = parseLimit(url.searchParams.get("limit"))
  const bucket = url.searchParams.get("bucket")?.trim() || null
  const filter = url.searchParams.get("filter")
  const familyKind = url.searchParams.get("familyKind")?.trim() || null
  const llmStatusFilter = url.searchParams.get("llmStatus")?.trim() || null
  const minObservationCount = toFiniteNumber(url.searchParams.get("minObservationCount"))
  const sortRaw = url.searchParams.get("sort")?.trim() || "updated_at_desc"
  const sort = SORT_OPTIONS.has(sortRaw) ? sortRaw : "updated_at_desc"

  const supabase = createAdminClient()
  const { data, error } = await supabase.from("family_classification_current").select("id,cluster_id,family_kind,family_title,family_summary,confidence,observation_count,classification_coverage_share,mixed_topic_score,cluster_path,needs_human_review,review_reasons,evidence,llm_status,llm_model,llm_classified_at,algorithm_version,classified_at,updated_at").limit(5000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let rows: QualityRow[] = ((data ?? []) as Record<string, unknown>[]).map((row) => {
    const evidence = asRecord(row.evidence)
    const representatives = asStringArray(evidence?.representatives)
    const phrases = asStringArray(evidence?.common_matched_phrases)
    const quality = computeFamilyQualityBucket(row)
    // Surface the LLM's suggested family_kind separately from the
    // heuristic's stored family_kind so the review form can show
    // heuristic-vs-LLM disagreement and the snapshot's
    // tie_break_context.llm_disagrees flag actually means something.
    const llmBlock = asRecord(evidence?.llm)
    const llmSuggestedFamilyKind =
      typeof llmBlock?.suggested_family_kind === "string"
        ? llmBlock.suggested_family_kind
        : null
    return {
      classification_id: typeof row.id === "string" ? row.id : null, cluster_id: String(row.cluster_id ?? ""), family_kind: typeof row.family_kind === "string" ? row.family_kind : null, family_title: typeof row.family_title === "string" ? row.family_title : null, family_summary: typeof row.family_summary === "string" ? row.family_summary : null, confidence: toFiniteNumber(row.confidence), llm_status: normalizeLlmStatus(row, evidence), llm_suggested_family_kind: llmSuggestedFamilyKind, observation_count: toFiniteNumber(row.observation_count) ?? 0,
      classification_coverage_share: toFiniteNumber(row.classification_coverage_share), mixed_topic_score: toFiniteNumber(row.mixed_topic_score), quality_bucket: quality.bucket, quality_reasons: quality.reasons, recommended_action: quality.recommendedAction,
      review_reasons: asStringArray(row.review_reasons), needs_human_review: row.needs_human_review === true, representative_count: representatives.length, representative_preview: representatives.slice(0, 3), common_matched_phrase_count: phrases.length, common_matched_phrase_preview: phrases.slice(0, 5), algorithm_version: typeof row.algorithm_version === "string" ? row.algorithm_version : null, llm_model: typeof row.llm_model === "string" ? row.llm_model : null, llm_classified_at: typeof row.llm_classified_at === "string" ? row.llm_classified_at : null, classified_at: typeof row.classified_at === "string" ? row.classified_at : null, updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    }
  })

  if (bucket) rows = rows.filter((r) => r.quality_bucket === bucket)
  if (familyKind) rows = rows.filter((r) => (r.family_kind ?? "") === familyKind)
  if (llmStatusFilter) rows = rows.filter((r) => (r.llm_status ?? "") === llmStatusFilter)
  if (minObservationCount !== null) rows = rows.filter((r) => r.observation_count >= minObservationCount)
  rows = sortRows(applyFilter(rows, filter), sort)

  const bucket_counts: Record<string, number> = {}
  const by_family_kind: Record<string, number> = {}
  const by_llm_status: Record<string, number> = {}
  const by_review_reason: Record<string, number> = {}
  let coverageSum = 0, coverageN = 0, mixedSum = 0, mixedN = 0, obsSum = 0
  for (const r of rows) {
    bucket_counts[r.quality_bucket] = (bucket_counts[r.quality_bucket] ?? 0) + 1
    by_family_kind[r.family_kind ?? "null"] = (by_family_kind[r.family_kind ?? "null"] ?? 0) + 1
    by_llm_status[r.llm_status ?? "null"] = (by_llm_status[r.llm_status ?? "null"] ?? 0) + 1
    for (const reason of r.review_reasons) by_review_reason[reason] = (by_review_reason[reason] ?? 0) + 1
    if (r.classification_coverage_share !== null) { coverageSum += r.classification_coverage_share; coverageN++ }
    if (r.mixed_topic_score !== null) { mixedSum += r.mixed_topic_score; mixedN++ }
    obsSum += r.observation_count
  }

  return NextResponse.json({
    limit,
    summary: {
      bucket_counts,
      by_family_kind,
      by_llm_status,
      by_review_reason,
      averages: {
        observation_count: rows.length ? obsSum / rows.length : null,
        classification_coverage_share: coverageN ? coverageSum / coverageN : null,
        mixed_topic_score: mixedN ? mixedSum / mixedN : null,
      },
    },
    rows: rows.slice(0, limit),
  })
}
