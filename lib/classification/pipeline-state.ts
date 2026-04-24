export type PipelineDataState =
  | "healthy"
  | "empty_healthy"
  | "pending_classification"
  | "degraded"

export type PipelineDegradedReason =
  | "source_query_failed"
  | "openai_unconfigured"
  | "classify_backfill_failed"
  | "unknown"

export interface PipelineStateSummary {
  data_state: PipelineDataState
  source_status: "healthy" | "degraded"
  degraded_reason: PipelineDegradedReason | null
  observations_in_window: number
  clustered_count: number
  classified_count: number
  pending_clustering: number
  pending_classification: number
  /**
   * Subset of `pending_classification` at or above MIN_IMPACT_SCORE. The
   * admin classify-backfill panel only processes rows in this bucket, so
   * when it differs from `pending_classification` the UI needs to
   * distinguish "backlog the operator can clear" from "backlog below
   * policy threshold". Defaults to `pending_classification` when the
   * caller hasn't measured it — backwards-compatible for any existing
   * consumer that builds summaries without the new input.
   */
  high_impact_pending_classification: number
}

export interface BuildPipelineStateInput {
  observationsInWindow: number
  clusteredCount: number
  classifiedCount: number
  highImpactPendingClassification?: number
  sourceHealthy?: boolean
  openaiConfigured?: boolean
  lastClassifyBackfillStatus?: string | null
}

export function buildPipelineStateSummary(
  input: BuildPipelineStateInput,
): PipelineStateSummary {
  const observationsInWindow = Math.max(0, input.observationsInWindow)
  const clusteredCount = Math.max(0, input.clusteredCount)
  const classifiedCount = Math.max(0, input.classifiedCount)
  const pendingClassification = Math.max(0, observationsInWindow - classifiedCount)
  const pendingClustering = Math.max(0, observationsInWindow - clusteredCount)
  const highImpactPendingClassification = Math.min(
    pendingClassification,
    Math.max(
      0,
      input.highImpactPendingClassification ?? pendingClassification,
    ),
  )
  const sourceHealthy = input.sourceHealthy !== false

  const base = {
    observations_in_window: observationsInWindow,
    clustered_count: clusteredCount,
    classified_count: classifiedCount,
    pending_clustering: pendingClustering,
    pending_classification: pendingClassification,
    high_impact_pending_classification: highImpactPendingClassification,
  }

  if (!sourceHealthy) {
    return {
      data_state: "degraded",
      source_status: "degraded",
      degraded_reason: "source_query_failed",
      ...base,
    }
  }

  if (input.openaiConfigured === false) {
    return {
      data_state: "degraded",
      source_status: "healthy",
      degraded_reason: "openai_unconfigured",
      ...base,
    }
  }

  if (input.lastClassifyBackfillStatus === "failed") {
    return {
      data_state: "degraded",
      source_status: "healthy",
      degraded_reason: "classify_backfill_failed",
      ...base,
    }
  }

  if (observationsInWindow === 0) {
    return {
      data_state: "empty_healthy",
      source_status: "healthy",
      degraded_reason: null,
      ...base,
    }
  }

  if (pendingClassification > 0) {
    return {
      data_state: "pending_classification",
      source_status: "healthy",
      degraded_reason: null,
      ...base,
    }
  }

  return {
    data_state: "healthy",
    source_status: "healthy",
    degraded_reason: null,
    ...base,
  }
}
