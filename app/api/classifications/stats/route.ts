import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { logServerError } from "@/lib/error-tracking/server-logger"
import { buildPipelineStateSummary, type PipelineStateSummary } from "@/lib/classification/pipeline-state"

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

// Prerequisite status of the ingest → cluster → classify pipeline for the
// current time window. Powers the empty-state panel on the AI triage tab
// so a reviewer can see which step is blocking (and deep-link to the right
// admin tab to trigger it) instead of getting a generic "no classifications
// yet" message. See components/dashboard/classification-triage.tsx.
//
// All counts are canonical observations only (is_canonical = true on
// mv_observation_current) — duplicate/detached rows would distort the
// progress ratios. `classifiedCount` and `clusteredCount` derive from
// `llm_classified_at` / `cluster_id` on the same MV so they're already
// window-filtered by published_at alongside `observationsInWindow`.
interface PrerequisiteStatus {
  observationsInWindow: number
  classifiedCount: number
  clusteredCount: number
  pendingClassification: number
  pendingClustering: number
  openaiConfigured: boolean
  lastScrape: { at: string | null; status: string | null }
  lastClassifyBackfill: { at: string | null; status: string | null }
}

interface PipelineSummaryPayload {
  prerequisites: PrerequisiteStatus
  pipeline_state: PipelineStateSummary
}

// Fan out the four prerequisite queries in parallel, resilient to any one
// of them failing — the panel degrades to nulls rather than 500'ing the
// stats endpoint. Canonical observations only; the `is_canonical` index
// makes the count queries cheap. `lastClassifyBackfill` is identified by
// `source_id IS NULL` (admin + cron share the convention — see
// app/api/cron/classify-backfill/route.ts).
async function computePrerequisites(
  supabase: Awaited<ReturnType<typeof createClient>>,
  publishedAtCutoff: Date | null,
): Promise<PipelineSummaryPayload | null> {
  try {
    const cutoffIso = publishedAtCutoff?.toISOString() ?? null

    const obsBase = () => {
      let q = supabase
        .from("mv_observation_current")
        .select("*", { count: "exact", head: true })
        .eq("is_canonical", true)
      if (cutoffIso) q = q.gte("published_at", cutoffIso)
      return q
    }

    const [obsRes, classifiedRes, clusteredRes, lastScrapeRes, lastBackfillRes] =
      await Promise.all([
        obsBase(),
        obsBase().not("llm_classified_at", "is", null),
        obsBase().not("cluster_id", "is", null),
        supabase
          .from("scrape_logs")
          .select("started_at, completed_at, status")
          .not("source_id", "is", null)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("scrape_logs")
          .select("started_at, completed_at, status")
          .is("source_id", null)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])

    const observationsInWindow = obsRes.count ?? 0
    const classifiedCount = classifiedRes.count ?? 0
    const clusteredCount = clusteredRes.count ?? 0

    const pickTs = (row: { completed_at?: string | null; started_at?: string | null } | null) =>
      row?.completed_at ?? row?.started_at ?? null

    const prerequisites = {
      observationsInWindow,
      classifiedCount,
      clusteredCount,
      pendingClassification: Math.max(0, observationsInWindow - classifiedCount),
      pendingClustering: Math.max(0, observationsInWindow - clusteredCount),
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      lastScrape: {
        at: pickTs(lastScrapeRes.data),
        status: (lastScrapeRes.data?.status as string | null) ?? null,
      },
      lastClassifyBackfill: {
        at: pickTs(lastBackfillRes.data),
        status: (lastBackfillRes.data?.status as string | null) ?? null,
      },
    }
    return {
      prerequisites,
      pipeline_state: buildPipelineStateSummary({
        observationsInWindow,
        classifiedCount,
        clusteredCount,
        openaiConfigured: prerequisites.openaiConfigured,
        lastClassifyBackfillStatus: prerequisites.lastClassifyBackfill.status,
      }),
    }
  } catch (error) {
    logServerError(
      "api-classifications-stats",
      "prerequisites_fetch_failed",
      error,
      { publishedAtCutoff: publishedAtCutoff?.toISOString() ?? null },
    )
    return null
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  // Parse as_of parameter for point-in-time replay
  const asOfRaw = searchParams.get("as_of")
  let asOf: Date | null = null
  if (asOfRaw) {
    const parsed = new Date(asOfRaw)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        {
          error: "Invalid as_of",
          message: "as_of must be a valid ISO8601 timestamp",
        },
        { status: 400 },
      )
    }
    if (parsed.getTime() > Date.now() + 60_000) {
      return NextResponse.json(
        {
          error: "Invalid as_of",
          message: "as_of cannot be in the future",
        },
        { status: 400 },
      )
    }
    asOf = parsed
  }

  // Optional `?days=N` window for the prerequisite panel. Mirrors the
  // pattern used by /api/stats and /api/classifications' global time
  // filter — unset/0 = all time. The aggregate classification stats
  // (total, byCategory, …) intentionally stay window-agnostic since the
  // panel reads prereq fields separately from the totals.
  const daysRaw = searchParams.get("days")
  const parsedDays = daysRaw !== null ? Number.parseInt(daysRaw, 10) : NaN
  const windowDays =
    Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : null
  const anchor = asOf ?? new Date()
  const publishedAtCutoff = windowDays
    ? new Date(anchor.getTime() - windowDays * 24 * 60 * 60 * 1000)
    : null

  // Prereq fetch runs in parallel with the classification read below
  // (they have no data dependency). Keeps p50 close to max(classQuery,
  // prereqQuery) rather than the sum.
  const prerequisitesPromise = computePrerequisites(supabase, publishedAtCutoff)

  let classificationQuery = supabase
    .from("classifications")
    .select("id, category, severity, status, needs_human_review, observation_id")
  if (asOf) {
    classificationQuery = classificationQuery.lte("created_at", asOf.toISOString())
  }

  const { data: classificationData, error } = await classificationQuery

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (classificationData || []) as ClassificationRow[]
  if (rows.length === 0) {
    const summary = await prerequisitesPromise
    return NextResponse.json({
      total: 0,
      needsReviewCount: 0,
      traceableCount: 0,
      traceabilityCoverage: 0,
      byCategory: {},
      bySeverity: {},
      byStatus: {},
      bySentiment: { positive: 0, negative: 0, neutral: 0, unknown: 0 },
      prerequisites: summary?.prerequisites ?? null,
      pipeline_state:
        summary?.pipeline_state ??
        buildPipelineStateSummary({
          observationsInWindow: 0,
          classifiedCount: 0,
          clusteredCount: 0,
          sourceHealthy: false,
        }),
    })
  }

  let reviewQuery = supabase
    .from("classification_reviews")
    .select("classification_id, status, category, severity, needs_human_review, reviewed_at")
    .in(
      "classification_id",
      rows.map((r) => r.id),
    )
    .order("reviewed_at", { ascending: false })
  if (asOf) {
    reviewQuery = reviewQuery.lte("reviewed_at", asOf.toISOString())
  }

  const { data: reviewData } = await reviewQuery

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

  const summary = await prerequisitesPromise

  return NextResponse.json({
    total: rows.length,
    needsReviewCount,
    traceableCount,
    traceabilityCoverage: rows.length ? Number(((traceableCount / rows.length) * 100).toFixed(1)) : 0,
    byCategory,
    bySeverity,
    byStatus,
    bySentiment,
    prerequisites: summary?.prerequisites ?? null,
    pipeline_state:
      summary?.pipeline_state ??
      buildPipelineStateSummary({
        observationsInWindow: 0,
        classifiedCount: 0,
        clusteredCount: 0,
        sourceHealthy: false,
      }),
  })
}
