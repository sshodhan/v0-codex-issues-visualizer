import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { processObservationClassificationQueue } from "@/lib/classification/pipeline"
import {
  buildBackfillCandidates,
  type BackfillSourceRow,
} from "@/lib/classification/backfill-candidates"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Daily Vercel-cron entry that catches up the long tail of unclassified
// high-impact observations the ingest-time pipeline never reached
// (pre-fingerprint backfill rows, ingest-time classifier failures, etc.).
//
// The ingest pipeline (lib/scrapers/index.ts → processObservationClassificationQueue)
// only enqueues NEW observations; rows that existed before the classifier
// was wired up — or whose first attempt errored — silently accreted as
// "high impact, no LLM signal". This route closes that gap by walking
// mv_observation_current for the highest-impact unclassified rows and
// routing them through the same queue with the dedupe guard engaged
// (reclassifyExisting=false).
//
// Budget: DEFAULT_LIMIT obs/run, ~$1/run at gpt-5-mini rates. Limit cap
// is intentionally tight; clearing a 10k-row backlog at the default cap
// takes ~400 days. Bump --limit (or add a one-shot admin route parallel
// to /api/admin/backfill-derivations) if the backlog grows.
//
// Run summary is logged to scrape_logs (source_id=null) so the
// dashboard's "Last sync" chip surfaces backfill activity alongside
// scrape activity.
//
// See docs/ARCHITECTURE.md §3.1d and reflection.md item #5.

// 5 min upper bound for the full chunk on plans that allow it; on Hobby
// the route still works — Vercel clamps to plan limits and the dedupe
// guard keeps a partial run idempotent across retries.
export const maxDuration = 300

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const MIN_IMPACT_SCORE = 6

const SELECT_COLS = [
  "observation_id",
  "title",
  "content",
  "url",
  "source_id",
  "cli_version",
  "fp_os",
  "fp_shell",
  "fp_editor",
  "model_id",
  "repro_markers",
  "llm_classified_at",
  "impact_score",
  "published_at",
].join(", ")

export async function GET(request: NextRequest) {
  const isProduction =
    process.env.VERCEL_ENV === "production" ||
    (!process.env.VERCEL_ENV && process.env.NODE_ENV === "production")
  const expectedSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")

  if (expectedSecret) {
    if (authHeader !== `Bearer ${expectedSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  } else if (isProduction) {
    // Fail-closed in production rather than silently allowing the
    // route to run unauthenticated. Mirrors lib/admin/auth.ts policy
    // for the admin surface.
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    )
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Classifier not configured", message: "OPENAI_API_KEY missing" },
      { status: 503 },
    )
  }

  const url = new URL(request.url)
  const limitParam = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT)
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(limitParam) ? limitParam : DEFAULT_LIMIT, MAX_LIMIT),
  )

  const supabase = createAdminClient()

  // Open the run row up front so a mid-flight crash is visible as
  // status='running' rather than disappearing entirely.
  const { data: log } = await supabase
    .from("scrape_logs")
    .insert({ source_id: null, status: "running" })
    .select()
    .single()

  const finalize = async (
    fields: Partial<{
      status: "completed" | "failed"
      issues_found: number
      issues_added: number
      error_message: string
    }>,
  ) => {
    if (!log) return
    await supabase
      .from("scrape_logs")
      .update({
        ...fields,
        completed_at: new Date().toISOString(),
      })
      .eq("id", log.id)
  }

  const { data: rows, error: queryErr } = await supabase
    .from("mv_observation_current")
    .select(SELECT_COLS)
    .is("llm_classified_at", null)
    .gte("impact_score", MIN_IMPACT_SCORE)
    .order("impact_score", { ascending: false })
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(limit)

  if (queryErr) {
    await finalize({ status: "failed", error_message: queryErr.message })
    logServerError("classify-backfill", "query_failed", queryErr)
    return NextResponse.json({ error: queryErr.message }, { status: 500 })
  }

  const observations = (rows ?? []) as unknown as BackfillSourceRow[]
  if (observations.length === 0) {
    await finalize({ status: "completed", issues_found: 0, issues_added: 0 })
    return NextResponse.json({
      candidates: 0,
      classified: 0,
      skipped: 0,
      failed: 0,
      refreshedMvs: false,
    })
  }

  const sourceIds = Array.from(
    new Set(
      observations
        .map((row) => row.source_id)
        .filter((id): id is string => Boolean(id)),
    ),
  )
  const slugById = new Map<string, string>()
  if (sourceIds.length > 0) {
    const { data: sources, error: srcErr } = await supabase
      .from("sources")
      .select("id, slug")
      .in("id", sourceIds)
    if (srcErr) {
      await finalize({ status: "failed", error_message: srcErr.message })
      logServerError("classify-backfill", "sources_lookup_failed", srcErr)
      return NextResponse.json({ error: srcErr.message }, { status: 500 })
    }
    for (const row of sources ?? []) {
      slugById.set(row.id as string, row.slug as string)
    }
  }

  const candidates = buildBackfillCandidates(observations, slugById)

  logServer({
    component: "classify-backfill",
    event: "queue_started",
    level: "info",
    data: { candidates: candidates.length, limit },
  })

  const result = await processObservationClassificationQueue(supabase, candidates, {
    reclassifyExisting: false,
  })

  // Refresh MVs so mv_observation_current's joined llm_* columns reflect
  // the new classifications on the next dashboard tick. Mirrors the
  // post-scrape refresh in lib/scrapers/index.ts → runAllScrapers.
  let refreshedMvs = false
  const { error: refreshErr } = await supabase.rpc("refresh_materialized_views")
  if (refreshErr) {
    logServerError("classify-backfill", "mv_refresh_failed", refreshErr)
  } else {
    refreshedMvs = true
  }

  await finalize({
    status: "completed",
    issues_found: result.attempted,
    issues_added: result.classified,
    ...(result.failures.length > 0
      ? { error_message: `${result.failures.length} classification failures` }
      : {}),
  })

  return NextResponse.json({
    candidates: result.attempted,
    classified: result.classified,
    skipped: result.skipped,
    failed: result.failures.length,
    refreshedMvs,
  })
}
