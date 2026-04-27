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
  clampMinImpact,
} from "@/lib/classification/run-backfill-constants"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Re-exported so admin/cron routes can read the threshold off the
// orchestrator without importing the constants module directly.
export { MIN_IMPACT_SCORE, clampMinImpact }

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
  // Admin-only override. When omitted, the orchestrator applies the
  // default `MIN_IMPACT_SCORE` policy — the daily cron and every other
  // caller therefore behave unchanged. Only the admin panel passes an
  // override (for operators experimenting with what a lower threshold
  // would classify). Clamped to [0, 10] upstream.
  minImpactScore?: number
}

export interface CountBackfillOptions {
  minImpactScore?: number
  /**
   * Optional `published_at >=` cutoff. When set, the count is
   * restricted to observations published on or after this timestamp —
   * mirrors the dashboard banner's windowed counts so the admin panel
   * can show a matching number.
   */
  publishedSince?: Date | null
}

export interface RunClassifyBackfillResult extends ClassificationQueueResult {
  // Alias of `attempted` so the route's response contract stays
  // { candidates, classified, skipped, failed, refreshedMvs } — the
  // cron's pre-refactor shape that the admin panel also consumes.
  candidates: number
  failed: number
  refreshedMvs: boolean
  /** Effective threshold used for this run (echoes the override or the
   *  default so the operator can confirm the admin form was respected). */
  minImpactScore: number
}

export async function runClassifyBackfill(
  supabase: AdminClient,
  options: RunClassifyBackfillOptions,
): Promise<RunClassifyBackfillResult> {
  const { limit } = options
  const shouldRefreshMvs = options.refreshMvs !== false
  const threshold = clampMinImpact(options.minImpactScore)

  const { data: rows, error: queryErr } = await supabase
    .from("mv_observation_current")
    .select(BACKFILL_SELECT_CLAUSE)
    .is("llm_classified_at", null)
    .eq("is_canonical", true)
    .gte("impact_score", threshold)
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
      minImpactScore: threshold,
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
    minImpactScore: threshold,
  }
}

// Pending candidate count at a given threshold + window. The admin
// panel passes both `minImpactScore` (so operators can experiment) and
// `publishedSince` (so the count matches the dashboard banner's 30-day
// window). When neither is set, behavior is identical to the previous
// unparametrized version: default threshold, all-time.
//
// Keeping this function pure-ish (no route-layer concerns) means the
// cron path can call it without knowing about windows or overrides.
export async function countBackfillCandidates(
  supabase: AdminClient,
  opts: CountBackfillOptions = {},
): Promise<number> {
  const threshold = clampMinImpact(opts.minImpactScore)
  let q = supabase
    .from("mv_observation_current")
    .select("observation_id", { count: "exact", head: true })
    .is("llm_classified_at", null)
    .eq("is_canonical", true)
    .gte("impact_score", threshold)
  if (opts.publishedSince) {
    q = q.gte("published_at", opts.publishedSince.toISOString())
  }
  const { count, error } = await q

  if (error) {
    // PostgREST sometimes returns `{ message: "" }` for transient
    // failures (aborted fetch, connection drop). Without query context
    // the operator can't tell which of the five parallel counts blew up
    // — log the threshold and window so the line is actionable on its
    // own.
    logServerError("classify-backfill", "count_failed", error, {
      table: "mv_observation_current",
      threshold,
      publishedSince: opts.publishedSince?.toISOString() ?? null,
    })
    throw error
  }
  return count ?? 0
}

// Count all unclassified canonical observations regardless of impact
// score. Paired with `countBackfillCandidates`: the admin panel shows
// both so operators understand why "Run until done" stops while the
// dashboard still reports pending rows (the below-threshold subset is
// intentionally deferred per policy). Accepts the same windowing param.
export async function countBackfillCandidatesAllImpact(
  supabase: AdminClient,
  opts: Pick<CountBackfillOptions, "publishedSince"> = {},
): Promise<number> {
  let q = supabase
    .from("mv_observation_current")
    .select("observation_id", { count: "exact", head: true })
    .is("llm_classified_at", null)
    .eq("is_canonical", true)
  if (opts.publishedSince) {
    q = q.gte("published_at", opts.publishedSince.toISOString())
  }
  const { count, error } = await q

  if (error) {
    logServerError("classify-backfill", "count_all_impact_failed", error, {
      table: "mv_observation_current",
      publishedSince: opts.publishedSince?.toISOString() ?? null,
    })
    throw error
  }
  return count ?? 0
}
