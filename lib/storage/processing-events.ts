import type { createAdminClient } from "@/lib/supabase/admin"

export type ProcessingStage = "fingerprinting" | "embedding" | "clustering" | "classification" | "review"

export interface ProcessingEventInput {
  observationId: string
  stage: ProcessingStage
  status: string
  algorithmVersionModel?: string | null
  detail?: Record<string, unknown> | null
}

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Append-only processing event writer.
 *
 * This helper intentionally never updates prior rows; each transition is
 * a new immutable insert so retry/escalation chains remain auditable.
 */
export async function recordProcessingEvent(
  supabase: AdminClient,
  input: ProcessingEventInput,
): Promise<void> {
  const { error } = await supabase.from("processing_events").insert({
    observation_id: input.observationId,
    stage: input.stage,
    status: input.status,
    algorithm_version_model: input.algorithmVersionModel ?? null,
    detail_json: input.detail ?? {},
  })

  if (error) {
    console.error("[processing-events] failed to append event", {
      observationId: input.observationId,
      stage: input.stage,
      status: input.status,
      error: error.message,
    })
  }
}
