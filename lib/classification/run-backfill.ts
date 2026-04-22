import type { createAdminClient } from "@/lib/supabase/admin"
import {
  processObservationClassificationQueue,
  type ClassificationQueueResult,
} from "@/lib/classification/pipeline"
import {
  buildBackfillCandidates,
  type BackfillSourceRow,
} from "@/lib/classification/backfill-candidates"
import {
  BACKFILL_SELECT_CLAUSE,
  MIN_IMPACT_SCORE,
} from "@/lib/classification/run-backfill-constants"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Re-exported so admin/cron routes can read the threshold off the
// orchestrator without importing the constants module directly.
export { MIN_IMPACT_SCORE }

// Shared orchestrator for the classify-backfill flow. Two callers:
//   - /api/cron/classify-backfill (daily Vercel cron, CRON_SECRET gate)
//   - /api/admin/classify-backfill (operator one-shot, ADMIN_SECRET gate)
//
// They share the same DB-read + queue + MV-refresh sequence but differ on
// auth boundary, default limit, and MV-refresh policy (the admin loop
// skips per-batch refresh to avoid N MV rebuilds during a bulk catch-up).
// Keep the body pure-ish: scrape_logs bookkeeping stays in the routes so
// each auth surface owns its own audit row.

type AdminClient = ReturnType<typeof createAdminClient>

export interface RunClassifyBackfillOptions {
  limit: number
  // Cron always refreshes at the end of its daily run. The admin
  // "Run until done" loop skips intermediate refreshes and triggers a
  // single refresh on the final batch — otherwise a 10-batch catch-up
  // would rebuild MVs 10 times in quick succession.
  refreshMvs?: boolean
}

export interface RunClassifyBackfillResult extends ClassificationQueueResult {
  // Alias of `attempted` so the route's response contract stays
  // { candidates, classified, skipped, failed, refreshedMvs } — the
  // cron's pre-refactor shape that the admin panel also consumes.
  candidates: number
  failed: number
  refreshedMvs: boolean
}

export async function runClassifyBackfill(
  supabase: AdminClient,
  options: RunClassifyBackfillOptions,
): Promise<RunClassifyBackfillResult> {
  const { limit } = options
  const shouldRefreshMvs = options.refreshMvs !== false

  const { data: rows, error: queryErr } = await supabase
    .from("mv_observation_current")
    .select(BACKFILL_SELECT_CLAUSE)
    .is("llm_classified_at", null)
    .eq("is_canonical", true)
    .gte("impact_score", MIN_IMPACT_SCORE)
    .order("impact_score", { ascending: false })
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(limit)

  if (queryErr) {
    logServerError("classify-backfill", "query_failed", queryErr)
    throw queryErr
  }

  const observations = (rows ?? []) as unknown as BackfillSourceRow[]
  if (observations.length === 0) {
    return {
      attempted: 0,
      candidates: 0,
      classified: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      refreshedMvs: false,
    }
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
      logServerError("classify-backfill", "sources_lookup_failed", srcErr)
      throw srcErr
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

  // Only refresh when something actually changed — a no-op batch (all
  // candidates already classified, raced with a prior run) shouldn't
  // trigger the ~5s MV rebuild cost.
  let refreshedMvs = false
  if (shouldRefreshMvs && result.classified > 0) {
    const { error: refreshErr } = await supabase.rpc("refresh_materialized_views")
    if (refreshErr) {
      logServerError("classify-backfill", "mv_refresh_failed", refreshErr)
    } else {
      refreshedMvs = true
    }
  }

  return {
    attempted: result.attempted,
    candidates: result.attempted,
    classified: result.classified,
    skipped: result.skipped,
    failed: result.failures.length,
    failures: result.failures,
    refreshedMvs,
  }
}

// Pending candidate count for the admin panel's stat tile and GET
// response. Same WHERE clause as runClassifyBackfill's SELECT so the
// count is consistent with what a subsequent POST would actually
// process; `head: true` keeps the response payload empty.
export async function countBackfillCandidates(
  supabase: AdminClient,
): Promise<number> {
  const { count, error } = await supabase
    .from("mv_observation_current")
    .select("observation_id", { count: "exact", head: true })
    .is("llm_classified_at", null)
    .eq("is_canonical", true)
    .gte("impact_score", MIN_IMPACT_SCORE)

  if (error) {
    logServerError("classify-backfill", "count_failed", error)
    throw error
  }
  return count ?? 0
}
