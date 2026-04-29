import type { SupabaseClient } from "@supabase/supabase-js"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Async job queue for Stage 4 classification work. The admin panel
// enqueues a job and gets a job_id back immediately; subsequent batches
// are processed by the cron tick (and opportunistically by the
// /:id/advance endpoint while the operator's browser is open).
//
// This module is the data layer ONLY. It knows how to insert/claim/
// finalize a row in `classification_jobs`; it does NOT know how to
// classify an observation or a cluster. The worker
// (app/api/cron/classification-jobs + the per-id advance route) wires
// this up to `runClassifyBackfill` and `classifyClusterFamily`.
//
// See scripts/033_classification_jobs.sql for the table shape and
// docs/ARCHITECTURE.md §6.0 for where Stage 4 sits in the pipeline.

const LOG_COMPONENT = "classification-jobs"

// Bound the failures buffer so a runaway job can't write tens of
// thousands of failure rows into one jsonb column. The worker keeps the
// most-recent N entries; older failures live only in scrape_logs.
const FAILURE_BUFFER_LIMIT = 25

// How long a 'running' job can go without a heartbeat before another
// cron tick is allowed to reclaim it. Longer than the Hobby
// maxDuration (60s) so a still-running tick doesn't get stolen, shorter
// than a "stuck forever" window so a crashed function doesn't pin the
// row indefinitely.
export const RUNNING_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000

export type ClassificationJobKind = "observation" | "cluster"

export type ClassificationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export interface ObservationJobParams {
  limit: number
  minImpactScore?: number
  refreshMvs?: boolean
}

export interface ClusterJobParams {
  limit: number
  /** Optional explicit list. When set, the worker classifies these
   *  cluster_ids in order instead of ranking by observation_count. */
  clusterIds?: string[]
}

export type ClassificationJobParams = ObservationJobParams | ClusterJobParams

export interface ClassificationJobFailure {
  /** observation_id for kind='observation', cluster_id for kind='cluster' */
  itemId: string
  reason: string
  occurredAt: string
}

export interface ClassificationJobRow {
  id: string
  kind: ClassificationJobKind
  status: ClassificationJobStatus
  params: ClassificationJobParams
  total_target: number | null
  processed: number
  classified: number
  failed: number
  failures: ClassificationJobFailure[]
  last_error: string | null
  heartbeat_at: string | null
  last_log_id: string | null
  enqueued_by: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  cancelled_at: string | null
}

type AdminClient = SupabaseClient

// PostgREST returns columns as `unknown` until we cast — funnel that
// through one normalizer so callers get a stable shape.
function normalizeJobRow(raw: Record<string, unknown>): ClassificationJobRow {
  return {
    id: String(raw.id),
    kind: raw.kind as ClassificationJobKind,
    status: raw.status as ClassificationJobStatus,
    params: (raw.params ?? {}) as ClassificationJobParams,
    total_target:
      raw.total_target === null || raw.total_target === undefined
        ? null
        : Number(raw.total_target),
    processed: Number(raw.processed ?? 0),
    classified: Number(raw.classified ?? 0),
    failed: Number(raw.failed ?? 0),
    failures: Array.isArray(raw.failures)
      ? (raw.failures as ClassificationJobFailure[])
      : [],
    last_error: (raw.last_error as string | null) ?? null,
    heartbeat_at: (raw.heartbeat_at as string | null) ?? null,
    last_log_id: (raw.last_log_id as string | null) ?? null,
    enqueued_by: (raw.enqueued_by as string | null) ?? null,
    created_at: String(raw.created_at),
    started_at: (raw.started_at as string | null) ?? null,
    finished_at: (raw.finished_at as string | null) ?? null,
    cancelled_at: (raw.cancelled_at as string | null) ?? null,
  }
}

export interface EnqueueOptions {
  kind: ClassificationJobKind
  params: ClassificationJobParams
  /** Optional pre-computed candidate count. When known at enqueue
   *  time the operator-facing UI can show a progress bar immediately;
   *  worker fills this in lazily otherwise. */
  totalTarget?: number | null
  enqueuedBy?: string
}

export async function enqueueJob(
  supabase: AdminClient,
  opts: EnqueueOptions,
): Promise<ClassificationJobRow> {
  const { data, error } = await supabase
    .from("classification_jobs")
    .insert({
      kind: opts.kind,
      params: opts.params,
      total_target: opts.totalTarget ?? null,
      enqueued_by: opts.enqueuedBy ?? "admin",
    })
    .select()
    .single()

  if (error || !data) {
    logServerError(LOG_COMPONENT, "enqueue_failed", error, {
      kind: opts.kind,
    })
    throw error ?? new Error("Failed to enqueue classification job")
  }

  logServer({
    component: LOG_COMPONENT,
    event: "enqueued",
    level: "info",
    data: { id: (data as { id: string }).id, kind: opts.kind },
  })

  return normalizeJobRow(data as Record<string, unknown>)
}

export async function getJob(
  supabase: AdminClient,
  id: string,
): Promise<ClassificationJobRow | null> {
  const { data, error } = await supabase
    .from("classification_jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (error) {
    logServerError(LOG_COMPONENT, "get_failed", error, { id })
    throw error
  }
  if (!data) return null
  return normalizeJobRow(data as Record<string, unknown>)
}

export interface ListJobsOptions {
  /** When true, return only queued + running jobs. Used by the per-panel
   *  active-job badge so the UI doesn't have to filter client-side. */
  activeOnly?: boolean
  /** Filter to one Stage 4 sub-product. */
  kind?: ClassificationJobKind
  limit?: number
}

export async function listJobs(
  supabase: AdminClient,
  opts: ListJobsOptions = {},
): Promise<ClassificationJobRow[]> {
  let q = supabase
    .from("classification_jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 25)

  if (opts.activeOnly) {
    q = q.in("status", ["queued", "running"])
  }
  if (opts.kind) {
    q = q.eq("kind", opts.kind)
  }

  const { data, error } = await q
  if (error) {
    logServerError(LOG_COMPONENT, "list_failed", error)
    throw error
  }
  return (data ?? []).map((row) => normalizeJobRow(row as Record<string, unknown>))
}

// Pick up the next eligible job for the worker. Eligibility = queued OR
// running-but-stale-heartbeat. Returns null when the queue is idle.
//
// We don't need a SELECT FOR UPDATE because the cron tick is the only
// caller; concurrent ticks are extremely rare and the heartbeat fence
// catches them anyway. Picking the oldest queued first is FIFO; running
// jobs are reclaimed only after their heartbeat is older than
// RUNNING_HEARTBEAT_TIMEOUT_MS.
export async function claimNextJob(
  supabase: AdminClient,
): Promise<ClassificationJobRow | null> {
  const cutoff = new Date(Date.now() - RUNNING_HEARTBEAT_TIMEOUT_MS).toISOString()

  // Queued jobs come first (FIFO); fall back to stale-running.
  const { data: queued, error: queuedErr } = await supabase
    .from("classification_jobs")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)

  if (queuedErr) {
    logServerError(LOG_COMPONENT, "claim_queued_failed", queuedErr)
    throw queuedErr
  }
  if (queued && queued.length > 0) {
    return normalizeJobRow(queued[0] as Record<string, unknown>)
  }

  const { data: stale, error: staleErr } = await supabase
    .from("classification_jobs")
    .select("*")
    .eq("status", "running")
    .lt("heartbeat_at", cutoff)
    .order("heartbeat_at", { ascending: true, nullsFirst: true })
    .limit(1)

  if (staleErr) {
    logServerError(LOG_COMPONENT, "claim_stale_failed", staleErr)
    throw staleErr
  }
  if (stale && stale.length > 0) {
    logServer({
      component: LOG_COMPONENT,
      event: "stale_job_reclaimed",
      level: "warn",
      data: { id: (stale[0] as { id: string }).id },
    })
    return normalizeJobRow(stale[0] as Record<string, unknown>)
  }

  return null
}

// Mark a job as 'running' and stamp the heartbeat. Idempotent — calling
// this on an already-running job just refreshes the heartbeat (which is
// what the worker wants on every batch iteration).
export async function markJobRunning(
  supabase: AdminClient,
  id: string,
  patch: Partial<Pick<ClassificationJobRow, "total_target" | "last_log_id">> = {},
): Promise<ClassificationJobRow> {
  const now = new Date().toISOString()
  const update: Record<string, unknown> = {
    status: "running",
    heartbeat_at: now,
  }
  // Only stamp started_at on the first transition; PostgREST coalesce
  // is awkward, so the worker passes total_target only on the first
  // claim and we trust it's null otherwise.
  if (patch.total_target !== undefined) update.total_target = patch.total_target
  if (patch.last_log_id !== undefined) update.last_log_id = patch.last_log_id

  // Two-step so we can detect first-run (started_at IS NULL) without a
  // full SELECT. If started_at already exists we keep it; otherwise we
  // stamp it now.
  const { data: existing, error: existingErr } = await supabase
    .from("classification_jobs")
    .select("started_at, status")
    .eq("id", id)
    .maybeSingle()

  if (existingErr) {
    logServerError(LOG_COMPONENT, "mark_running_lookup_failed", existingErr, { id })
    throw existingErr
  }
  if (!existing) {
    throw new Error(`classification_job ${id} not found`)
  }

  // Refuse to re-run a finished or cancelled job.
  const status = (existing as { status: ClassificationJobStatus }).status
  if (status === "completed" || status === "failed" || status === "cancelled") {
    throw new Error(`classification_job ${id} is ${status}; cannot mark running`)
  }

  if (!(existing as { started_at: string | null }).started_at) {
    update.started_at = now
  }

  const { data, error } = await supabase
    .from("classification_jobs")
    .update(update)
    .eq("id", id)
    .select()
    .single()

  if (error || !data) {
    logServerError(LOG_COMPONENT, "mark_running_failed", error, { id })
    throw error ?? new Error("Failed to mark job running")
  }
  return normalizeJobRow(data as Record<string, unknown>)
}

export interface BatchProgress {
  processed: number
  classified: number
  failed: number
  newFailures?: ClassificationJobFailure[]
  /** Total candidate count, set on the first batch when the worker
   *  finally knows the size. Subsequent batches pass undefined. */
  totalTarget?: number
  /** Most recent error message; null clears it on a successful batch. */
  lastError?: string | null
}

// Apply a batch's progress to the job. Adds (not replaces) processed/
// classified/failed counts and folds new failures into the rolling
// buffer keyed by itemId (most recent wins).
export async function recordBatchProgress(
  supabase: AdminClient,
  id: string,
  progress: BatchProgress,
): Promise<ClassificationJobRow> {
  // Pull current row so we can do additive math for the count columns.
  // Doing this server-side via an RPC would be cleaner, but admin-only
  // workloads at this scale (< 100 jobs/day) don't justify a SQL fn.
  const current = await getJob(supabase, id)
  if (!current) {
    throw new Error(`classification_job ${id} not found`)
  }

  const mergedFailures = mergeFailureBuffer(
    current.failures,
    progress.newFailures ?? [],
  )

  const update: Record<string, unknown> = {
    processed: current.processed + progress.processed,
    classified: current.classified + progress.classified,
    failed: current.failed + progress.failed,
    failures: mergedFailures,
    heartbeat_at: new Date().toISOString(),
  }
  if (progress.totalTarget !== undefined) {
    update.total_target = progress.totalTarget
  }
  if (progress.lastError !== undefined) {
    update.last_error = progress.lastError
  }

  const { data, error } = await supabase
    .from("classification_jobs")
    .update(update)
    .eq("id", id)
    .select()
    .single()

  if (error || !data) {
    logServerError(LOG_COMPONENT, "record_progress_failed", error, { id })
    throw error ?? new Error("Failed to record job progress")
  }
  return normalizeJobRow(data as Record<string, unknown>)
}

// Most-recent N failures, deduped by itemId so a retry-failure doesn't
// double-count.
function mergeFailureBuffer(
  prior: ClassificationJobFailure[],
  incoming: ClassificationJobFailure[],
): ClassificationJobFailure[] {
  if (incoming.length === 0) return prior
  const byId = new Map<string, ClassificationJobFailure>()
  for (const f of prior) byId.set(f.itemId, f)
  for (const f of incoming) byId.set(f.itemId, f)
  // Sort by occurredAt desc, take last N.
  return Array.from(byId.values())
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
    .slice(0, FAILURE_BUFFER_LIMIT)
}

export type FinalStatus = "completed" | "failed"

export async function finalizeJob(
  supabase: AdminClient,
  id: string,
  status: FinalStatus,
  lastError?: string | null,
): Promise<ClassificationJobRow> {
  const now = new Date().toISOString()
  const update: Record<string, unknown> = {
    status,
    finished_at: now,
    heartbeat_at: now,
  }
  if (lastError !== undefined) {
    update.last_error = lastError
  }

  const { data, error } = await supabase
    .from("classification_jobs")
    .update(update)
    .eq("id", id)
    .select()
    .single()

  if (error || !data) {
    logServerError(LOG_COMPONENT, "finalize_failed", error, { id })
    throw error ?? new Error("Failed to finalize job")
  }

  logServer({
    component: LOG_COMPONENT,
    event: "finalized",
    level: status === "completed" ? "info" : "warn",
    data: { id, status },
  })

  return normalizeJobRow(data as Record<string, unknown>)
}

// Operator-driven cancel. Idempotent: cancelling a finished job is a
// no-op and returns the existing row; cancelling a running job lets the
// worker exit on its next heartbeat check (see worker logic).
export async function cancelJob(
  supabase: AdminClient,
  id: string,
): Promise<ClassificationJobRow> {
  const current = await getJob(supabase, id)
  if (!current) {
    throw new Error(`classification_job ${id} not found`)
  }
  if (
    current.status === "completed" ||
    current.status === "failed" ||
    current.status === "cancelled"
  ) {
    return current
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("classification_jobs")
    .update({
      status: "cancelled",
      cancelled_at: now,
      finished_at: now,
    })
    .eq("id", id)
    .select()
    .single()

  if (error || !data) {
    logServerError(LOG_COMPONENT, "cancel_failed", error, { id })
    throw error ?? new Error("Failed to cancel job")
  }

  logServer({
    component: LOG_COMPONENT,
    event: "cancelled",
    level: "info",
    data: { id },
  })

  return normalizeJobRow(data as Record<string, unknown>)
}

// Cheap "is this job still allowed to keep running?" check the worker
// uses between batches so an operator-cancel takes effect within one
// batch instead of waiting for the whole limit to drain.
export async function isJobActive(
  supabase: AdminClient,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("classification_jobs")
    .select("status")
    .eq("id", id)
    .maybeSingle()
  if (error) {
    logServerError(LOG_COMPONENT, "is_active_failed", error, { id })
    return false
  }
  if (!data) return false
  const status = (data as { status: ClassificationJobStatus }).status
  return status === "queued" || status === "running"
}
