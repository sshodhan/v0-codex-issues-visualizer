import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  getClusterLabelStats,
  runClusterLabelBackfill,
} from "@/lib/storage/run-cluster-label-backfill"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Operator one-shot for the deterministic cluster-label backfill
// (scripts/021_backfill_deterministic_labels.ts). Same orchestrator
// (lib/storage/run-cluster-label-backfill.ts) so the admin panel and
// the CLI are guaranteed to behave identically.
//
// Auth: ADMIN_SECRET via x-admin-secret header (parallel to
// /api/admin/classify-backfill). No CRON path — the cron handles
// label writes via the live scrape pipeline; this route is for the
// one-shot operator catch-up after a v2 model bump.
//
// Audit: writes a scrape_logs(source_id=null) row when --apply runs,
// matching the classify-backfill convention so admin activity is
// visible in the same history.

export const maxDuration = 300

const DEFAULT_BATCH_SIZE = 200
const MAX_BATCH_SIZE = 500
const MAX_LIMIT = 10_000

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const supabase = createAdminClient()
  try {
    const stats = await getClusterLabelStats(supabase)
    return NextResponse.json(stats)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("admin-cluster-label-backfill", "stats_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  let body: { apply?: boolean; limit?: number; batchSize?: number } = {}
  try {
    body = await request.json()
  } catch {
    // Empty body is fine — defaults to dry-run.
  }

  const apply = body.apply === true
  const limitRaw = body.limit == null ? undefined : Number(body.limit)
  const limit =
    limitRaw == null || !Number.isFinite(limitRaw)
      ? undefined
      : Math.max(1, Math.min(limitRaw, MAX_LIMIT))
  const batchSizeRaw = body.batchSize == null ? DEFAULT_BATCH_SIZE : Number(body.batchSize)
  const batchSize = Math.max(
    1,
    Math.min(Number.isFinite(batchSizeRaw) ? batchSizeRaw : DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
  )

  const supabase = createAdminClient()

  // Dry-run: no audit row, no DB writes. Operators use this to preview
  // by_model distribution and candidate count before authorising spend.
  if (!apply) {
    try {
      const { summary } = await runClusterLabelBackfill(supabase, {
        apply: false,
        limit,
        batchSize,
      })
      return NextResponse.json({ dryRun: true, ...summary })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logServerError("admin-cluster-label-backfill", "dryrun_failed", error)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // Apply path: create an audit row, run, finalize. The orchestrator
  // throws on member/cluster fetch errors; per-row RPC failures are
  // counted into rpc_failures so the operator sees partial success.
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
      .update({ ...fields, completed_at: new Date().toISOString() })
      .eq("id", log.id)
  }

  logServer({
    component: "admin-cluster-label-backfill",
    event: "run_started",
    level: "info",
    data: { apply, limit, batchSize },
  })

  try {
    const { summary } = await runClusterLabelBackfill(supabase, {
      apply: true,
      limit,
      batchSize,
    })
    await finalize({
      status: "completed",
      issues_found: summary.candidate_clusters,
      issues_added: summary.relabelled - summary.rpc_failures,
      ...(summary.rpc_failures > 0
        ? { error_message: `${summary.rpc_failures} set_cluster_label RPC failures` }
        : {}),
    })
    return NextResponse.json({ dryRun: false, ...summary })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finalize({ status: "failed", error_message: message })
    logServerError("admin-cluster-label-backfill", "run_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
