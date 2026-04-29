import type { SupabaseClient } from "@supabase/supabase-js"
import {
  type ClassificationJobRow,
  type ClassificationJobFailure,
  type ObservationJobParams,
  type ClusterJobParams,
  recordBatchProgress,
  finalizeJob,
  isJobActive,
  markJobRunning,
} from "./classification-jobs"
import { runClassifyBackfill } from "@/lib/classification/run-backfill"
import { classifyClusterFamily } from "@/lib/storage/family-classification"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// One-batch worker for the classification_jobs queue. The cron tick
// (and the operator-driven /:id/advance endpoint) call processOneBatch
// to push a single chunk through, then return; both can call it again
// in a loop until the function-duration budget runs out.
//
// Splitting "process one batch" from "drive the loop" keeps the worker
// stateless and lets two callers (cron + browser-poll) cooperate
// without stepping on each other — the heartbeat fence in
// claimNextJob/markJobRunning prevents double-processing.

const LOG_COMPONENT = "classification-jobs-worker"

// Per-batch chunk size. Observation batches have headroom (~3-5s/call,
// 10 items ≈ 50s) but cluster classification calls are heavier
// (~5-15s/call → keep batches small to stay under Hobby's 60s
// maxDuration with margin for the wrapping route).
const OBSERVATION_BATCH_SIZE = 10
const CLUSTER_BATCH_SIZE = 4

const CURRENT_FAMILY_VERSION = CURRENT_VERSIONS.family_classification

type AdminClient = SupabaseClient

export interface BatchOutcome {
  /** True when the job is fully drained after this batch. The caller
   *  uses this to decide whether to call processOneBatch again or stop
   *  for this tick. */
  done: boolean
  processedThisBatch: number
  classifiedThisBatch: number
  failedThisBatch: number
  /** When non-null, the worker hit a fatal error and finalized the job
   *  as 'failed'. The route layer should surface this to the caller. */
  fatalError: string | null
}

export async function processOneBatch(
  supabase: AdminClient,
  job: ClassificationJobRow,
): Promise<BatchOutcome> {
  // Re-check active before doing any work — operator may have cancelled
  // between the claim and now. Cheap (one PK lookup) and avoids a
  // wasted batch.
  if (!(await isJobActive(supabase, job.id))) {
    return {
      done: true,
      processedThisBatch: 0,
      classifiedThisBatch: 0,
      failedThisBatch: 0,
      fatalError: null,
    }
  }

  // Stamp 'running' (idempotent — refreshes the heartbeat). Do this
  // BEFORE the work so a long batch can't be reclaimed mid-flight.
  await markJobRunning(supabase, job.id)

  try {
    if (job.kind === "observation") {
      return await processObservationBatch(supabase, job)
    }
    if (job.kind === "cluster") {
      return await processClusterBatch(supabase, job)
    }
    // Defensive — schema CHECK already constrains kind, but TS doesn't
    // know that.
    throw new Error(`Unknown job kind: ${(job as { kind: string }).kind}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError(LOG_COMPONENT, "batch_failed", error, { id: job.id, kind: job.kind })
    await finalizeJob(supabase, job.id, "failed", message)
    return {
      done: true,
      processedThisBatch: 0,
      classifiedThisBatch: 0,
      failedThisBatch: 0,
      fatalError: message,
    }
  }
}

async function processObservationBatch(
  supabase: AdminClient,
  job: ClassificationJobRow,
): Promise<BatchOutcome> {
  const params = job.params as ObservationJobParams
  const remaining = job.total_target == null
    ? OBSERVATION_BATCH_SIZE
    : Math.max(0, job.total_target - job.processed)
  // Cap each batch at OBSERVATION_BATCH_SIZE regardless of remaining;
  // the loop driver will call us again. Honor params.limit as a job
  // total budget — never run more rows than the operator asked for.
  const totalBudget = Math.max(0, params.limit - job.processed)
  const batchSize = Math.min(OBSERVATION_BATCH_SIZE, totalBudget, remaining || OBSERVATION_BATCH_SIZE)

  if (batchSize <= 0) {
    await finalizeJob(supabase, job.id, "completed")
    return {
      done: true,
      processedThisBatch: 0,
      classifiedThisBatch: 0,
      failedThisBatch: 0,
      fatalError: null,
    }
  }

  // Skip the per-batch MV refresh — the cron tick that drains the queue
  // can rebuild MVs once at the end (or the daily classify-backfill
  // cron at 03:00 UTC will pick it up). Otherwise a 10-batch job
  // rebuilds MVs 10 times for a few seconds each.
  const result = await runClassifyBackfill(supabase, {
    limit: batchSize,
    refreshMvs: false,
    minImpactScore: params.minImpactScore,
  })

  const newFailures: ClassificationJobFailure[] = result.failures.map((f) => ({
    itemId: f.observationId ?? "unknown",
    reason: f.reason ?? "unknown",
    occurredAt: new Date().toISOString(),
  }))

  const updated = await recordBatchProgress(supabase, job.id, {
    processed: result.attempted,
    classified: result.classified,
    failed: result.failed,
    newFailures,
    lastError: null,
    // First batch sets total_target if not already set: use the
    // operator's requested limit as the upper bound (the actual queue
    // may be smaller, in which case we'll finalize early below).
    totalTarget:
      job.total_target == null && job.processed === 0 ? params.limit : undefined,
  })

  // The orchestrator returns attempted=0 when the candidate queue is
  // empty — that's our "no more work" signal. Otherwise the operator's
  // limit being met is the upper bound.
  const queueExhausted = result.attempted === 0
  const budgetExhausted = updated.processed >= params.limit
  const done = queueExhausted || budgetExhausted

  if (done) {
    await finalizeJob(supabase, job.id, "completed")
  }

  logServer({
    component: LOG_COMPONENT,
    event: "observation_batch_done",
    level: "info",
    data: {
      id: job.id,
      attempted: result.attempted,
      classified: result.classified,
      failed: result.failed,
      done,
    },
  })

  return {
    done,
    processedThisBatch: result.attempted,
    classifiedThisBatch: result.classified,
    failedThisBatch: result.failed,
    fatalError: null,
  }
}

async function processClusterBatch(
  supabase: AdminClient,
  job: ClassificationJobRow,
): Promise<BatchOutcome> {
  const params = job.params as ClusterJobParams
  const totalBudget = Math.max(0, params.limit - job.processed)
  const batchSize = Math.min(CLUSTER_BATCH_SIZE, totalBudget)

  if (batchSize <= 0) {
    await finalizeJob(supabase, job.id, "completed")
    return {
      done: true,
      processedThisBatch: 0,
      classifiedThisBatch: 0,
      failedThisBatch: 0,
      fatalError: null,
    }
  }

  // Resolve the next batch of cluster_ids. Two paths mirror the
  // synchronous /api/admin/family-classification handler:
  //   - explicit clusterIds[] passed at enqueue time (operator pinned a
  //     list — typically from the quality dashboard's selection)
  //   - top-N largest unclassified clusters (default queue-drain mode)
  let clusterIds: string[]
  if (params.clusterIds && params.clusterIds.length > 0) {
    // Slice the explicit list at the current offset. processed acts
    // as the offset because we walk the list in order.
    const start = job.processed
    clusterIds = params.clusterIds.slice(start, start + batchSize)
  } else {
    clusterIds = await fetchNextRankedClusterBatch(supabase, batchSize)
  }

  if (clusterIds.length === 0) {
    // First batch with zero candidates → set total_target to 0 so the
    // UI shows "0 of 0" instead of an unbounded spinner.
    if (job.total_target == null) {
      await recordBatchProgress(supabase, job.id, {
        processed: 0,
        classified: 0,
        failed: 0,
        totalTarget: 0,
      })
    }
    await finalizeJob(supabase, job.id, "completed")
    return {
      done: true,
      processedThisBatch: 0,
      classifiedThisBatch: 0,
      failedThisBatch: 0,
      fatalError: null,
    }
  }

  let classifiedCount = 0
  let failedCount = 0
  const newFailures: ClassificationJobFailure[] = []

  // Sequential, not parallel — each cluster classify is a single OpenAI
  // call already (~5-15s); parallelizing would punch through the 60s
  // function ceiling. Per-cluster try/catch so one bad cluster doesn't
  // poison the rest of the batch.
  for (const clusterId of clusterIds) {
    // Mid-batch cancel check: skip remaining work and let the worker
    // exit. Operator gets sub-batch cancel latency (one cluster, ~10s)
    // instead of waiting for the full batch.
    if (!(await isJobActive(supabase, job.id))) break

    try {
      const draft = await classifyClusterFamily(supabase, clusterId)
      if (!draft) {
        failedCount++
        newFailures.push({
          itemId: clusterId,
          reason: "classifier returned null",
          occurredAt: new Date().toISOString(),
        })
        continue
      }
      const { error: insertErr } = await supabase
        .from("family_classifications")
        .insert({
          cluster_id: draft.cluster_id,
          algorithm_version: draft.algorithm_version,
          family_title: draft.family_title,
          family_summary: draft.family_summary,
          family_kind: draft.family_kind,
          dominant_topic_slug: draft.dominant_topic_slug,
          primary_failure_mode: draft.primary_failure_mode,
          affected_surface: draft.affected_surface,
          likely_owner_area: draft.likely_owner_area,
          severity_rollup: draft.severity_rollup,
          confidence: draft.confidence,
          needs_human_review: draft.needs_human_review,
          review_reasons: draft.review_reasons,
          evidence: draft.evidence,
        })
      if (insertErr) {
        failedCount++
        newFailures.push({
          itemId: clusterId,
          reason: insertErr.message,
          occurredAt: new Date().toISOString(),
        })
      } else {
        classifiedCount++
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failedCount++
      newFailures.push({
        itemId: clusterId,
        reason,
        occurredAt: new Date().toISOString(),
      })
      logServerError(LOG_COMPONENT, "cluster_item_failed", error, { id: job.id, cluster_id: clusterId })
    }
  }

  const attempted = clusterIds.length

  // First batch: lock in total_target. For explicit clusterIds the
  // total is known up front; for ranked-mode we use the operator's
  // requested limit (the queue may be smaller, handled in the
  // queueExhausted branch below).
  let totalTargetUpdate: number | undefined
  if (job.total_target == null) {
    totalTargetUpdate =
      params.clusterIds && params.clusterIds.length > 0
        ? params.clusterIds.length
        : params.limit
  }

  const updated = await recordBatchProgress(supabase, job.id, {
    processed: attempted,
    classified: classifiedCount,
    failed: failedCount,
    newFailures,
    lastError: null,
    totalTarget: totalTargetUpdate,
  })

  // Done conditions:
  //   - queueExhausted: ranked mode returned fewer rows than asked
  //   - explicit list walked to the end
  //   - budget hit (operator's params.limit reached)
  const queueExhausted = !params.clusterIds && attempted < batchSize
  const explicitListExhausted =
    params.clusterIds &&
    job.processed + attempted >= params.clusterIds.length
  const budgetExhausted = updated.processed >= params.limit
  const done = queueExhausted || explicitListExhausted || budgetExhausted

  if (done) {
    await finalizeJob(supabase, job.id, "completed")
  }

  logServer({
    component: LOG_COMPONENT,
    event: "cluster_batch_done",
    level: "info",
    data: {
      id: job.id,
      attempted,
      classified: classifiedCount,
      failed: failedCount,
      done,
    },
  })

  return {
    done,
    processedThisBatch: attempted,
    classifiedThisBatch: classifiedCount,
    failedThisBatch: failedCount,
    fatalError: null,
  }
}

// Mirror of /api/admin/family-classification's POST batch path: rank
// alive clusters by observation_count desc, exclude those already at
// the current algorithm_version, return the next `limit` ids. Kept
// in this file (not extracted) so the synchronous route's logic stays
// canonical and we don't accidentally diverge.
async function fetchNextRankedClusterBatch(
  supabase: AdminClient,
  limit: number,
): Promise<string[]> {
  const { data: currentRows, error: currentErr } = await supabase
    .from("family_classification_current")
    .select("cluster_id")
    .eq("algorithm_version", CURRENT_FAMILY_VERSION)

  if (currentErr) {
    logServerError(LOG_COMPONENT, "current_list_failed", currentErr)
    throw currentErr
  }

  const upToDate = new Set(
    (currentRows ?? []).map((c: { cluster_id: string }) => c.cluster_id),
  )

  // Over-fetch to leave room after filtering out up-to-date rows; same
  // ratio (4x) the synchronous handler uses.
  const { data: ranked, error: rankedErr } = await supabase
    .from("mv_cluster_topic_metadata")
    .select("cluster_id, observation_count")
    .gt("observation_count", 0)
    .order("observation_count", { ascending: false })
    .limit(limit * 4)

  if (rankedErr) {
    logServerError(LOG_COMPONENT, "ranked_list_failed", rankedErr)
    throw rankedErr
  }

  return (ranked ?? [])
    .filter((c: { cluster_id: string }) => !upToDate.has(c.cluster_id))
    .slice(0, limit)
    .map((c: { cluster_id: string }) => c.cluster_id)
}
