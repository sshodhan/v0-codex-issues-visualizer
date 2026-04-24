import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  countBackfillCandidates,
  countBackfillCandidatesAllImpact,
  runClassifyBackfill,
  MIN_IMPACT_SCORE,
} from "@/lib/classification/run-backfill"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Operator one-shot for clearing a classify-backfill backlog (BUGS.md
// N-10). Parallel to /api/admin/backfill-derivations: shares the
// orchestrator with /api/cron/classify-backfill but runs behind the
// ADMIN_SECRET gate (x-admin-secret header) rather than CRON_SECRET.
//
// The daily cron caps at 10 obs/run — correct for steady-state catch-up,
// useless for an initial backlog (10k rows ≈ 3 years). This route lets
// an operator iterate batches up to MAX_LIMIT per call from the admin
// panel's "Run until done" loop.
//
// Audit: writes run rows to scrape_logs(source_id=null) — same shape as
// the cron — so admin activity is visible in the same history.
// /api/stats excludes source_id=null from the "Last synced" header chip
// so admin runs never masquerade as scrapes.
//
// See docs/ARCHITECTURE.md §3.5 (scheduled jobs + manual triggers).

export const maxDuration = 60

const DEFAULT_LIMIT = 10
// 15 canonicals × ~3-5s/call = hard upper bound of what fits under
// Hobby's 60s maxDuration. 100 is the upper bound the panel exposes —
// operators running on Pro can push it, but on Hobby they must keep
// the per-batch limit low enough to finish.
const MAX_LIMIT = 100

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const supabase = createAdminClient()
  try {
    // Parallel: candidate-count queries are independent and share the
    // same MV + index, so issuing both at once avoids doubling the
    // panel's load latency when MIN_IMPACT_SCORE differs from 0.
    const [pendingCandidates, pendingCandidatesAllImpact] = await Promise.all([
      countBackfillCandidates(supabase),
      countBackfillCandidatesAllImpact(supabase),
    ])
    return NextResponse.json({
      pendingCandidates,
      pendingCandidatesAllImpact,
      defaultLimit: DEFAULT_LIMIT,
      maxLimit: MAX_LIMIT,
      minImpactScore: MIN_IMPACT_SCORE,
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("classify-backfill", "get_stats_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Classifier not configured", message: "OPENAI_API_KEY missing" },
      { status: 503 },
    )
  }

  let body: { limit?: number; refreshMvs?: boolean; dryRun?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    // Empty body is fine — defaults apply.
  }

  const limitRaw = Number(body.limit ?? DEFAULT_LIMIT)
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, MAX_LIMIT),
  )
  const dryRun = body.dryRun === true
  // Default true when omitted; the admin "Run until done" loop passes
  // false for intermediate batches and true for the final one so MVs
  // are rebuilt once per catch-up rather than per batch.
  const refreshMvs = body.refreshMvs !== false

  const supabase = createAdminClient()

  if (dryRun) {
    // Count-only preview: no model calls, no scrape_logs row. Operators
    // use this before authorizing spend.
    try {
      const pendingCandidates = await countBackfillCandidates(supabase)
      return NextResponse.json({
        dryRun: true,
        pendingCandidates,
        limit,
        minImpactScore: MIN_IMPACT_SCORE,
        wouldProcess: Math.min(limit, pendingCandidates),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // Mirror the cron's scrape_logs(source_id=null) lifecycle so admin
  // runs are visible in the same audit history as scheduled runs.
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

  logServer({
    component: "admin-classify-backfill",
    event: "run_started",
    level: "info",
    data: { limit, refreshMvs },
  })

  try {
    const result = await runClassifyBackfill(supabase, { limit, refreshMvs })

    await finalize({
      status: "completed",
      issues_found: result.attempted,
      issues_added: result.classified,
      ...(result.failures.length > 0
        ? { error_message: `${result.failures.length} classification failures` }
        : {}),
    })

    return NextResponse.json({
      dryRun: false,
      candidates: result.candidates,
      classified: result.classified,
      skipped: result.skipped,
      failed: result.failed,
      failures: result.failures,
      refreshedMvs: result.refreshedMvs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finalize({ status: "failed", error_message: message })
    logServerError("admin-classify-backfill", "run_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
