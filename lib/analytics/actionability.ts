export interface ActionabilityInput {
  impact_score: number
  frequency_count: number
  error_code?: string | null
  repro_markers?: number
  source_diversity?: number
}

export function computeActionability(input: ActionabilityInput): number {
  const impact = Number(input.impact_score || 0)
  const frequency = Number(input.frequency_count || 0)
  const repro = Number(input.repro_markers || 0)
  const sourceDiversity = Number(input.source_diversity || 1)

  const actionability =
    0.55 * (impact / 10) +
    0.2 * Math.min(frequency / 10, 1) +
    0.1 * (input.error_code ? 1 : 0) +
    0.08 * Math.min(repro / 3, 1) +
    0.07 * Math.min(Math.max(sourceDiversity - 1, 0) / 3, 1)

  return Number(Math.max(0, Math.min(actionability, 1)).toFixed(4))
}
