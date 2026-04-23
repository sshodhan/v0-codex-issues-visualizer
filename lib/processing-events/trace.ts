export interface ProcessingEventRow {
  id: string
  stage: string
  status: string
  algorithm_version_model: string | null
  detail_json: Record<string, unknown> | null
  created_at: string
}

export interface ObservationTrace {
  events: ProcessingEventRow[]
  classificationRetryChain: {
    attemptedModels: string[]
    escalated: boolean
  }
}

export function sortProcessingEvents(events: ProcessingEventRow[]): ProcessingEventRow[] {
  return [...events].sort((a, b) => {
    const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    if (timeDiff !== 0) return timeDiff
    return a.id.localeCompare(b.id)
  })
}

export function buildObservationTrace(events: ProcessingEventRow[]): ObservationTrace {
  const ordered = sortProcessingEvents(events)
  const classificationEvents = ordered.filter((event) => event.stage === "classification")

  const attemptedModels = classificationEvents
    .filter((event) => event.status === "attempted" || event.status === "completed")
    .map((event) => event.algorithm_version_model)
    .filter((value): value is string => Boolean(value))

  const uniqueAttemptedModels: string[] = []
  for (const model of attemptedModels) {
    if (!uniqueAttemptedModels.includes(model)) uniqueAttemptedModels.push(model)
  }

  const escalated = classificationEvents.some((event) => event.status === "escalated")

  return {
    events: ordered,
    classificationRetryChain: {
      attemptedModels: uniqueAttemptedModels,
      escalated,
    },
  }
}
