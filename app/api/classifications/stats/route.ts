import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Aggregates over classifications joined with their latest review (effective
// state). Traceability coverage is derived from the presence of
// `observation_id`, which links back to the evidence layer.
// See docs/ARCHITECTURE.md v10 §§3.3, 5.2, 7.2.
interface ClassificationRow {
  id: string
  category: string | null
  severity: string | null
  status: string | null
  needs_human_review: boolean | null
  observation_id: string | null
}

interface ReviewRow {
  classification_id: string
  status: string | null
  category: string | null
  severity: string | null
  needs_human_review: boolean | null
  reviewed_at: string
}

export async function GET() {
  const supabase = await createClient()

  const { data: classificationData, error } = await supabase
    .from("classifications")
    .select("id, category, severity, status, needs_human_review, observation_id")

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (classificationData || []) as ClassificationRow[]
  if (rows.length === 0) {
    return NextResponse.json({
      total: 0,
      needsReviewCount: 0,
      traceableCount: 0,
      traceabilityCoverage: 0,
      byCategory: {},
      bySeverity: {},
      byStatus: {},
      bySentiment: { positive: 0, negative: 0, neutral: 0, unknown: 0 },
    })
  }

  const { data: reviewData } = await supabase
    .from("classification_reviews")
    .select("classification_id, status, category, severity, needs_human_review, reviewed_at")
    .in(
      "classification_id",
      rows.map((r) => r.id),
    )
    .order("reviewed_at", { ascending: false })

  const latestReviewByClassification = new Map<string, ReviewRow>()
  for (const r of (reviewData || []) as ReviewRow[]) {
    if (!latestReviewByClassification.has(r.classification_id)) {
      latestReviewByClassification.set(r.classification_id, r)
    }
  }

  // For observation-linked classifications, read sentiment from the
  // evidence-joined materialized view. The ingest sentiment is the analyst-
  // facing signal; the classifier's category/severity are separate axes.
  const observationIds = rows
    .map((r) => r.observation_id)
    .filter((v): v is string => Boolean(v))
  let sentimentByObservation = new Map<string, string | null>()
  if (observationIds.length > 0) {
    const { data: obsSentiment } = await supabase
      .from("mv_observation_current")
      .select("observation_id, sentiment")
      .in("observation_id", observationIds)
    for (const row of obsSentiment || []) {
      sentimentByObservation.set(
        row.observation_id as string,
        (row.sentiment as string | null) ?? null,
      )
    }
  }

  const byCategory: Record<string, number> = {}
  const bySeverity: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const bySentiment: Record<string, number> = { positive: 0, negative: 0, neutral: 0, unknown: 0 }

  let needsReviewCount = 0
  let traceableCount = 0

  for (const row of rows) {
    const latest = latestReviewByClassification.get(row.id)
    const effectiveCategory = latest?.category ?? row.category
    const effectiveSeverity = latest?.severity ?? row.severity
    const effectiveStatus = latest?.status ?? row.status
    const effectiveNeedsReview = latest?.needs_human_review ?? row.needs_human_review

    byCategory[effectiveCategory || "unknown"] =
      (byCategory[effectiveCategory || "unknown"] || 0) + 1
    bySeverity[effectiveSeverity || "unknown"] =
      (bySeverity[effectiveSeverity || "unknown"] || 0) + 1
    byStatus[effectiveStatus || "unknown"] =
      (byStatus[effectiveStatus || "unknown"] || 0) + 1

    if (effectiveNeedsReview) needsReviewCount++
    if (row.observation_id) traceableCount++

    const sentiment = row.observation_id
      ? sentimentByObservation.get(row.observation_id) ?? null
      : null
    if (!sentiment) {
      bySentiment.unknown++
    } else if (sentiment in bySentiment) {
      bySentiment[sentiment]++
    } else {
      bySentiment.unknown++
    }
  }

  return NextResponse.json({
    total: rows.length,
    needsReviewCount,
    traceableCount,
    traceabilityCoverage: rows.length ? Number(((traceableCount / rows.length) * 100).toFixed(1)) : 0,
    byCategory,
    bySeverity,
    byStatus,
    bySentiment,
  })
}
