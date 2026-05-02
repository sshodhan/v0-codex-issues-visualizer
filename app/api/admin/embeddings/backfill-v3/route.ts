import { NextRequest, NextResponse } from "next/server"
import { requireAdminSecret } from "@/lib/admin/auth"
import { createAdminClient } from "@/lib/supabase/admin"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"
import { recomputeObservationEmbedding } from "@/lib/storage/semantic-clusters"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

/**
 * Phase 4 PR3 — v3 embedding backfill orchestration.
 *
 * Read-only by default (`?dry_run=true` is the default). Exposes
 * three operations:
 *
 *   GET  /api/admin/embeddings/backfill-v3
 *     Returns counts + first-N IDs that WOULD be embedded if apply
 *     were called. Same query the panel uses to render the dry-run
 *     preview.
 *
 *   POST /api/admin/embeddings/backfill-v3?dry_run=true
 *     Same as GET — explicit form for the panel's "Refresh preview"
 *     button.
 *
 *   POST /api/admin/embeddings/backfill-v3?dry_run=false&limit=N&include_stale=true
 *     Apply mode. Iterates the candidate set (up to `limit`),
 *     calls `recomputeObservationEmbedding` per obs (which after
 *     PR #199 dispatches to the v3 helper since
 *     CURRENT_VERSIONS.observation_embedding === "v3"). Returns
 *     batch stats.
 *
 * Hard prerequisite (operational, not enforced in code):
 *
 *   - PR #199 must be merged AND the v3 SQL bump
 *     (scripts/035_observation_embedding_v3_bump.sql) run.
 *   - Stage 4a coverage must be ≥ 80% per the runbook in
 *     docs/PHASE_4_4A_COVERAGE_RUNBOOK.md. The route will run
 *     against any coverage level — the gate is the operator's
 *     judgment, not a code check. If you bypass the runbook and
 *     run apply at low 4a coverage, you waste OpenAI quota
 *     producing v3 embeddings whose quality is bounded by the
 *     missing classifications.
 *
 * Resumability: pass `?resume_from=<observation_id>`. The route
 * filters to obs with `id > resume_from` (lexicographic). For a
 * single full-corpus push, this isn't strictly needed — the
 * candidate set shrinks naturally on each apply call as v3 rows
 * are created. But for multi-day backfills on larger corpora,
 * resume_from gives a deterministic restart point.
 *
 * Include-stale: `?include_stale=true` adds the subset of obs
 * that already have a v3 embedding BUT have a more recent
 * `processing_events.stage='embedding'/status='stale'` row (per
 * the convergence model in PR #198). These get re-embedded so
 * the v3 vector reflects the latest classification + reviewer
 * override state.
 */

// Pro plan caps serverless functions at 300s. Mirrors the
// classify-backfill route's reasoning. With ~487 obs and
// text-embedding-3-small at ~500ms per uncached call, full corpus
// ≈ 4 minutes. Operators run multiple batches via the panel's
// "Run until done" loop if more is needed.
export const maxDuration = 300

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 200

interface DryRunResponse {
  algorithm_version: string
  total_active_observations: number
  with_v3_embedding: number
  awaiting_v3_embedding: number
  stale_v3_embedding: number
  candidate_count: number
  candidate_ids_preview: string[]
  hints: {
    coverage_pct: number | null
    suggested_limit: number
    expected_cost_usd_per_full_run: number | null
  }
}

interface ApplyResponse {
  algorithm_version: string
  attempted: number
  succeeded: number
  failed: number
  cached: number
  failures: Array<{ observation_id: string; reason: string }>
  next_resume_from: string | null
  durationMs: number
}

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr
  return runDryRun(request)
}

export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const params = request.nextUrl.searchParams
  const dryRun = params.get("dry_run") !== "false" // default true
  if (dryRun) return runDryRun(request)
  return runApply(request)
}

async function runDryRun(request: NextRequest): Promise<NextResponse> {
  const supabase = createAdminClient()
  const params = request.nextUrl.searchParams
  const includeStale = params.get("include_stale") === "true"

  const { totalActive, withV3, candidateIds, staleCount } = await collectCandidates(supabase, {
    includeStale,
    resumeFrom: params.get("resume_from"),
    limit: MAX_LIMIT, // cap the preview so a huge corpus doesn't blow up the JSON
  })

  const awaiting = totalActive - withV3
  const coveragePct = totalActive > 0 ? withV3 / totalActive : null

  // Cost is per text-embedding-3-small call — ~$0.02 / 1M tokens. A
  // typical v3 input is ~600 tokens, so each call is ~$0.000012.
  // Across 500 obs = ~$0.006. Round up to a safe floor of $0.01 for
  // the hint, as actual cost varies with body length.
  const expectedCost = totalActive > 0 ? Math.max(0.01, totalActive * 0.000012) : null

  const response: DryRunResponse = {
    algorithm_version: CURRENT_VERSIONS.observation_embedding,
    total_active_observations: totalActive,
    with_v3_embedding: withV3,
    awaiting_v3_embedding: awaiting,
    stale_v3_embedding: staleCount,
    candidate_count: candidateIds.length,
    candidate_ids_preview: candidateIds.slice(0, 10),
    hints: {
      coverage_pct: coveragePct,
      suggested_limit: Math.min(DEFAULT_LIMIT, candidateIds.length),
      expected_cost_usd_per_full_run: expectedCost,
    },
  }
  return NextResponse.json(response)
}

async function runApply(request: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now()
  const supabase = createAdminClient()
  const params = request.nextUrl.searchParams

  const limitRaw = Number.parseInt(params.get("limit") ?? `${DEFAULT_LIMIT}`, 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, MAX_LIMIT)) : DEFAULT_LIMIT
  const includeStale = params.get("include_stale") === "true"

  const { candidateIds } = await collectCandidates(supabase, {
    includeStale,
    resumeFrom: params.get("resume_from"),
    limit,
  })

  if (candidateIds.length === 0) {
    return NextResponse.json({
      algorithm_version: CURRENT_VERSIONS.observation_embedding,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      cached: 0,
      failures: [],
      next_resume_from: null,
      durationMs: Date.now() - startedAt,
    } satisfies ApplyResponse)
  }

  // Fetch the observation rows we'll embed — title + content needed
  // by recomputeObservationEmbedding even though the v3 dispatcher
  // also re-fetches via buildV3InputFromObservation. The
  // outer fetch lets us hand recomputeObservationEmbedding a known
  // (id, title, content) shape; v3-input-from-observation fills in
  // the rest from side tables.
  const { data: obsRows, error: obsErr } = await supabase
    .from("observations")
    .select("id, title, content")
    .in("id", candidateIds)
  if (obsErr) {
    logServerError("v3-backfill", "observations_fetch_failed", obsErr)
    return NextResponse.json({ error: obsErr.message }, { status: 500 })
  }

  let succeeded = 0
  let failed = 0
  let cached = 0
  const failures: Array<{ observation_id: string; reason: string }> = []
  let lastProcessedId: string | null = null

  for (const row of (obsRows ?? []) as Array<{ id: string; title: string | null; content: string | null }>) {
    if (!row.id) continue
    const obsId = row.id

    try {
      const outcome = await recomputeObservationEmbedding(
        supabase,
        { id: obsId, title: row.title ?? "", content: row.content },
        { trigger: "v3_backfill_admin" },
      )
      if (outcome.ok) {
        succeeded++
      } else {
        failed++
        failures.push({ observation_id: obsId, reason: outcome.reason })
      }
    } catch (err) {
      failed++
      failures.push({
        observation_id: obsId,
        reason: err instanceof Error ? err.message : "unknown_error",
      })
    }

    lastProcessedId = obsId
  }

  logServer({
    component: "v3-backfill",
    event: "batch_complete",
    level: "info",
    data: {
      algorithm_version: CURRENT_VERSIONS.observation_embedding,
      attempted: candidateIds.length,
      succeeded,
      failed,
      cached,
      failure_count: failures.length,
      duration_ms: Date.now() - startedAt,
    },
  })

  const response: ApplyResponse = {
    algorithm_version: CURRENT_VERSIONS.observation_embedding,
    attempted: candidateIds.length,
    succeeded,
    failed,
    cached,
    failures: failures.slice(0, 20), // cap response size; the operator can re-run
    next_resume_from: lastProcessedId,
    durationMs: Date.now() - startedAt,
  }
  return NextResponse.json(response)
}

/**
 * Pure-ish helper that returns the obs IDs needing v3 embedding plus
 * top-level diagnostic counts. "Pure-ish" because it still touches
 * Supabase — fully extracting to a node-testable form would require
 * mocking out the query builder, which we already do in tests for the
 * fetcher (`tests/v3-input-from-observation.test.ts`). For PR3 we
 * keep the route thin and rely on integration testing for end-to-end
 * coverage. The core branching logic (awaiting vs stale subsets) is
 * simple enough to read and verify by inspection.
 */
async function collectCandidates(
  supabase: ReturnType<typeof createAdminClient>,
  opts: { includeStale: boolean; resumeFrom: string | null; limit: number },
): Promise<{
  totalActive: number
  withV3: number
  staleCount: number
  candidateIds: string[]
}> {
  // Total active = obs with at least one undetached cluster_member.
  // Same denominator the cluster-quality baseline metric uses.
  const { data: activeMembers, error: membersErr } = await supabase
    .from("cluster_members")
    .select("observation_id")
    .is("detached_at", null)
  if (membersErr) {
    logServerError("v3-backfill", "active_members_query_failed", membersErr)
    return { totalActive: 0, withV3: 0, staleCount: 0, candidateIds: [] }
  }
  const activeIds = new Set<string>()
  for (const row of (activeMembers ?? []) as Array<{ observation_id: string }>) {
    if (row.observation_id) activeIds.add(row.observation_id)
  }
  const totalActive = activeIds.size

  // Already-embedded at v3: filter observation_embeddings by current
  // algorithm_version. We pull obs_id + computed_at because the stale
  // check below joins on this set.
  //
  // Schema note: `observation_embeddings` has `computed_at` (bumped on
  // both INSERT and on-conflict UPDATE per scripts/012's
  // record_observation_embedding RPC). It does NOT have a `created_at`
  // column — querying for `created_at` returns "column does not exist"
  // and silently makes the v3CreatedByObs map empty, which would make
  // every active obs look "awaiting" forever.
  const { data: existingV3, error: existingErr } = await supabase
    .from("observation_embeddings")
    .select("observation_id, computed_at")
    .eq("algorithm_version", CURRENT_VERSIONS.observation_embedding)
  if (existingErr) {
    logServerError("v3-backfill", "existing_v3_query_failed", existingErr)
  }
  const v3ComputedByObs = new Map<string, string>()
  for (const row of (existingV3 ?? []) as Array<{ observation_id: string; computed_at: string }>) {
    if (row.observation_id) v3ComputedByObs.set(row.observation_id, row.computed_at)
  }
  const withV3 = v3ComputedByObs.size

  // Stale subset (only relevant when includeStale=true): obs with a
  // v3 embedding AND a `processing_events.stage='embedding' /
  // status='stale'` row whose created_at > the embedding's
  // computed_at. This is the convergence-model signal from PR #198 +
  // PR #199's stale-marker emission.
  //
  // Note: processing_events.created_at vs observation_embeddings.computed_at
  // is the right comparison — both represent "when did this row become
  // current in production". The marker is emitted at the moment a
  // classification/review write commits; the embedding's computed_at
  // bumps every time we (re-)embed. Marker > computed_at means the
  // upstream signal changed AFTER the most recent embed.
  let staleIds = new Set<string>()
  if (opts.includeStale && v3ComputedByObs.size > 0) {
    const { data: staleEvents, error: staleErr } = await supabase
      .from("processing_events")
      .select("observation_id, created_at, stage, status")
      .eq("stage", "embedding")
      .eq("status", "stale")
    if (staleErr) {
      logServerError("v3-backfill", "stale_events_query_failed", staleErr)
    }
    // For each stale event newer than the v3 row's computed_at,
    // include the observation_id in the stale set.
    for (const row of (staleEvents ?? []) as Array<{
      observation_id: string
      created_at: string
    }>) {
      const v3Computed = v3ComputedByObs.get(row.observation_id)
      if (!v3Computed) continue
      if (row.created_at > v3Computed) {
        staleIds.add(row.observation_id)
      }
    }
  }
  const staleCount = staleIds.size

  // Candidate set:
  //   awaiting (active AND no v3 row)  ∪  stale (when includeStale)
  // Filtered by resume_from (lex order) so multi-batch runs are
  // deterministic.
  const candidates: string[] = []
  for (const id of activeIds) {
    if (!v3ComputedByObs.has(id)) candidates.push(id)
  }
  if (opts.includeStale) {
    for (const id of staleIds) candidates.push(id)
  }

  let filtered = candidates.sort()
  if (opts.resumeFrom) {
    filtered = filtered.filter((id) => id > opts.resumeFrom!)
  }
  const limited = filtered.slice(0, opts.limit)

  return { totalActive, withV3, staleCount, candidateIds: limited }
}
