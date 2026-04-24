import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  clampMinImpact,
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
// The GET response now mirrors both the scope the dashboard banner uses
// (last N days, default 30) and the all-time scope the POST would
// actually process. Operators can also pass `minImpactScore` to preview
// what a lower threshold would process before authorizing spend; the
// daily cron and dashboard banner continue to use the hardcoded
// MIN_IMPACT_SCORE default so ephemeral admin experiments don't change
// system-wide policy.
//
// See docs/ARCHITECTURE.md §3.5 (scheduled jobs + manual triggers).

export const maxDuration = 60

const DEFAULT_LIMIT = 10
// 15 canonicals × ~3-5s/call = hard upper bound of what fits under
// Hobby's 60s maxDuration. 100 is the upper bound the panel exposes —
// operators running on Pro can push it, but on Hobby they must keep
// the per-batch limit low enough to finish.
const MAX_LIMIT = 100

// Default window for the admin panel's stats. Chosen to match the
// dashboard banner's default days filter so "N awaiting classification"
// on the banner and "N below threshold in window" on the admin panel
// are apples-to-apples. Admin can override via `?days=` on the GET.
const DEFAULT_WINDOW_DAYS = 30

function parseWindowDays(raw: string | null): number | null {
  if (raw === null || raw === "") return DEFAULT_WINDOW_DAYS
  if (raw === "all" || raw === "0") return null
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS
  return Math.min(365, n)
}

function parseMinImpact(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return MIN_IMPACT_SCORE
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw))
  return clampMinImpact(Number.isFinite(n) ? n : undefined)
}

function publishedSinceFromDays(days: number | null): Date | null {
  if (days === null) return null
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const params = request.nextUrl.searchParams
  const windowDays = parseWindowDays(params.get("days"))
  const minImpactScore = parseMinImpact(params.get("minImpactScore"))
  const publishedSince = publishedSinceFromDays(windowDays)

  const supabase = createAdminClient()
  try {
    // Issue five counts in parallel — same MV, same canonical index,
    // so the cost is dominated by the round-trip and this is one trip.
    //
    //   atThresholdWindowed  : what "Run until done" would process if
    //                          the admin switches the route to windowed
    //                          semantics (future); also the closest
    //                          apples-to-apples with the banner for
    //                          the operator's chosen threshold.
    //   atDefaultWindowed    : what the dashboard banner's high-impact
    //                          count is — the reference point for the
    //                          "change from default" callout.
    //   allImpactWindowed    : total unclassified rows in window,
    //                          regardless of threshold. Matches the
    //                          banner's "N awaiting classification".
    //   atThresholdAllTime   : what "Run until done" will actually
    //                          process today (route's operational
    //                          contract is still all-time). Matches
    //                          the "Pending candidates" tile.
    //   allImpactAllTime     : every unclassified row ever. Explains
    //                          the global deferral backlog.
    const [
      atThresholdWindowed,
      atDefaultWindowed,
      allImpactWindowed,
      atThresholdAllTime,
      allImpactAllTime,
    ] = await Promise.all([
      countBackfillCandidates(supabase, { minImpactScore, publishedSince }),
      countBackfillCandidates(supabase, { minImpactScore: MIN_IMPACT_SCORE, publishedSince }),
      countBackfillCandidatesAllImpact(supabase, { publishedSince }),
      countBackfillCandidates(supabase, { minImpactScore }),
      countBackfillCandidatesAllImpact(supabase),
    ])

    return NextResponse.json({
      // Back-compat fields (existing UI consumers continue to read these).
      pendingCandidates: atThresholdAllTime,
      pendingCandidatesAllImpact: allImpactAllTime,
      defaultLimit: DEFAULT_LIMIT,
      maxLimit: MAX_LIMIT,
      minImpactScore,
      defaultMinImpactScore: MIN_IMPACT_SCORE,
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      // New: scope + threshold breakdown for the rebuilt admin panel.
      window: {
        days: windowDays,
        startIso: publishedSince?.toISOString() ?? null,
      },
      counts: {
        atThresholdWindowed,
        atDefaultWindowed,
        allImpactWindowed,
        atThresholdAllTime,
        allImpactAllTime,
      },
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

  let body: {
    limit?: number
    refreshMvs?: boolean
    dryRun?: boolean
    // Optional per-request override. Clamped to [0, 10]; omission falls
    // back to MIN_IMPACT_SCORE so the route stays backward-compatible
    // for the existing admin page "Run until done" loop that doesn't
    // send this field yet.
    minImpactScore?: number
  } = {}
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
  const refreshMvs = body.refreshMvs !== false
  const minImpactScore = parseMinImpact(body.minImpactScore)

  const supabase = createAdminClient()

  if (dryRun) {
    // Count-only preview: no model calls, no scrape_logs row. Operators
    // use this before authorizing spend — especially important when
    // they've lowered the threshold and want to see exactly how many
    // rows the lower setting would process.
    try {
      const pendingCandidates = await countBackfillCandidates(supabase, { minImpactScore })
      return NextResponse.json({
        dryRun: true,
        pendingCandidates,
        limit,
        minImpactScore,
        defaultMinImpactScore: MIN_IMPACT_SCORE,
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
    data: { limit, refreshMvs, minImpactScore },
  })

  try {
    const result = await runClassifyBackfill(supabase, { limit, refreshMvs, minImpactScore })

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
      minImpactScore: result.minImpactScore,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finalize({ status: "failed", error_message: message })
    logServerError("admin-classify-backfill", "run_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
