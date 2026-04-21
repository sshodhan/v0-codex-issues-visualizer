import type { ClassificationPayload } from "@/lib/storage/derivations"

// Shape returned by the OpenAI classifier (strict JSON schema).
export interface ClassificationApiRecord {
  category: string
  subcategory: string
  severity: string
  status: string
  reproducibility: string
  impact: string
  confidence: number
  summary: string
  root_cause_hypothesis: string
  suggested_fix: string
  evidence_quotes: string[]
  alternate_categories: string[]
  tags: string[]
  needs_human_review: boolean
  review_reasons: string[]
}

// Non-model context threaded through from the /api/classify request.
export interface ClassificationContext {
  observation_id?: string
  prior_classification_id?: string
  model_used?: string
  retried_with_large_model?: boolean
}

export function toClassificationPayload(
  record: ClassificationApiRecord,
  reportText: string,
  context?: ClassificationContext,
): ClassificationPayload {
  return {
    ...record,
    raw_json: record,
    report_text: reportText,
    observation_id: context?.observation_id ?? null,
    prior_classification_id: context?.prior_classification_id ?? null,
    model_used: context?.model_used ?? null,
    retried_with_large_model: context?.retried_with_large_model ?? false,
  }
}
