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
}

export interface BuildPipelineStateInput {
  observationsInWindow: number
  clusteredCount: number
  classifiedCount: number
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
  const sourceHealthy = input.sourceHealthy !== false

  if (!sourceHealthy) {
    return {
      data_state: "degraded",
      source_status: "degraded",
      degraded_reason: "source_query_failed",
      observations_in_window: observationsInWindow,
      clustered_count: clusteredCount,
      classified_count: classifiedCount,
      pending_clustering: pendingClustering,
      pending_classification: pendingClassification,
    }
  }

  if (input.openaiConfigured === false) {
    return {
      data_state: "degraded",
      source_status: "healthy",
      degraded_reason: "openai_unconfigured",
      observations_in_window: observationsInWindow,
      clustered_count: clusteredCount,
      classified_count: classifiedCount,
      pending_clustering: pendingClustering,
      pending_classification: pendingClassification,
    }
  }

  if (input.lastClassifyBackfillStatus === "failed") {
    return {
      data_state: "degraded",
      source_status: "healthy",
      degraded_reason: "classify_backfill_failed",
      observations_in_window: observationsInWindow,
      clustered_count: clusteredCount,
      classified_count: classifiedCount,
      pending_clustering: pendingClustering,
      pending_classification: pendingClassification,
    }
  }

  if (observationsInWindow === 0) {
    return {
      data_state: "empty_healthy",
      source_status: "healthy",
      degraded_reason: null,
      observations_in_window: 0,
      clustered_count: clusteredCount,
      classified_count: classifiedCount,
      pending_clustering: pendingClustering,
      pending_classification: pendingClassification,
    }
  }

  if (pendingClassification > 0) {
    return {
      data_state: "pending_classification",
      source_status: "healthy",
      degraded_reason: null,
      observations_in_window: observationsInWindow,
      clustered_count: clusteredCount,
      classified_count: classifiedCount,
      pending_clustering: pendingClustering,
      pending_classification: pendingClassification,
    }
  }

  return {
    data_state: "healthy",
    source_status: "healthy",
    degraded_reason: null,
    observations_in_window: observationsInWindow,
    clustered_count: clusteredCount,
    classified_count: classifiedCount,
    pending_clustering: pendingClustering,
    pending_classification: pendingClassification,
  }
}
