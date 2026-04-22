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
// mv_observation_current for the highest-impact unclassified canonical
// observations and routing them through the same queue with the dedupe
// guard engaged (reclassifyExisting=false). Non-canonical members are
// skipped because cluster-level surfaces (Priority Matrix, AI tab
// triage) read off the canonical row; classifying members redundantly
// would burn ~$0.04 each without changing what the dashboard shows.
//
// Budget: DEFAULT_LIMIT canonicals/run × ~3-5s/call must fit under
// Vercel's plan-specific maxDuration (Hobby caps at 60s; Pro at 300s).
// 10/run leaves headroom on Hobby; bump via ?limit= when on Pro.
// Clearing a backlog of N canonicals at the default cap takes ~N/10
// days — long for big backlogs, but the right knob to widen is `?limit=`
// (or the admin one-shot route tracked as BUGS.md N-9), not the cron's
// default.
//
// Run summary is logged to scrape_logs(source_id=null) so the admin
// surface and BUGS.md N-10 follow-up can distinguish backfill activity
// from scrape activity. /api/stats explicitly excludes source_id=null
// rows from the "Last sync" chip so backfill runs don't masquerade as
// scrapes.
//
// Kill switch: set CLASSIFY_BACKFILL_DISABLED=1 to short-circuit
// without unsetting OPENAI_API_KEY (which would also break the ingest
// classifier and the SignalLayers Refresh button).
//
// See docs/ARCHITECTURE.md §3.5 (scheduled jobs) and reflection.md #5.

// Match the existing /api/cron/scrape ceiling so behavior is uniform
// across crons; Hobby plans clamp to 60 regardless. The dedupe guard
// keeps a partial-run-then-retry idempotent.
export const maxDuration = 60

const DEFAULT_LIMIT = 10
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
  if (process.env.CLASSIFY_BACKFILL_DISABLED === "1") {
    return NextResponse.json(
      { disabled: true, reason: "CLASSIFY_BACKFILL_DISABLED=1" },
      { status: 503 },
    )
  }

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

  // Restrict to canonical observations only. Cluster-level dashboard
  // surfaces (Priority Matrix bubbles, AI tab cluster groupings, hero
  // insight) read off the canonical row; classifying a non-canonical
  // member would burn ~$0.04 per call without making any of those
  // surfaces light up. Per-observation classification of members is
  // still available on demand via /api/observations/[id]/classify.
  const { data: rows, error: queryErr } = await supabase
    .from("mv_observation_current")
    .select(SELECT_COLS)
    .is("llm_classified_at", null)
    .eq("is_canonical", true)
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
