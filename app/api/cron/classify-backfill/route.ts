import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { runClassifyBackfill } from "@/lib/classification/run-backfill"
import { logServerError } from "@/lib/error-tracking/server-logger"

// Daily Vercel-cron entry that catches up the long tail of unclassified
// high-impact observations the ingest-time pipeline never reached
// (pre-fingerprint backfill rows, ingest-time classifier failures, etc.).
//
// The orchestration (mv_observation_current query → buildBackfillCandidates
// → processObservationClassificationQueue → MV refresh) lives in
// lib/classification/run-backfill.ts and is shared with the admin
// one-shot route /api/admin/classify-backfill (BUGS.md N-10). This file
// owns only the Vercel-cron-specific surface: CRON_SECRET auth,
// CLASSIFY_BACKFILL_DISABLED kill switch, scrape_logs(source_id=null)
// audit row, and OPENAI_API_KEY precondition.
//
// Budget: DEFAULT_LIMIT canonicals/run × ~3-5s/call must fit under
// Vercel's plan-specific maxDuration (Hobby caps at 60s; Pro at 300s).
// 10/run leaves headroom on Hobby; bump via ?limit= when on Pro, or use
// the admin panel's "Run until done" loop to clear a backlog.
//
// Run summary is logged to scrape_logs(source_id=null) so admin surfaces
// can distinguish backfill activity from scrape activity. /api/stats
// explicitly excludes source_id=null rows from the "Last sync" chip so
// backfill runs don't masquerade as scrapes.
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

  try {
    const result = await runClassifyBackfill(supabase, { limit })

    await finalize({
      status: "completed",
      issues_found: result.attempted,
      issues_added: result.classified,
      ...(result.failures.length > 0
        ? { error_message: `${result.failures.length} classification failures` }
        : {}),
    })

    return NextResponse.json({
      candidates: result.candidates,
      classified: result.classified,
      skipped: result.skipped,
      failed: result.failed,
      refreshedMvs: result.refreshedMvs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finalize({ status: "failed", error_message: message })
    logServerError("classify-backfill", "run_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
