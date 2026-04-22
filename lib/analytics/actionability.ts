// Actionability score (outcome D of the fingerprint-actionable PR).
//
// Blends the five per-row signals the triage analyst actually uses when
// deciding which cluster to promote to a ticket:
//   * impact          — the existing 1–10 score (55% — dominant term).
//   * frequency       — volume, clamped at 10 so a runaway cluster does
//                       not crowd out the other four signals (20%).
//   * error_code      — binary "is this code-addressable?" bit (10%).
//   * repro_markers   — how confidently a developer could replay the
//                       report; clamped at 3 which empirically separates
//                       "one-off screenshot" from "step-by-step repro" (8%).
//   * source_diversity — cross-source confirmation; baseline 1 source
//                       contributes 0, each additional source adds a
//                       capped bonus up to 3 extra sources (7%).
//
// Weights and clamps match docs/SCORING.md §10.1. The existing
// `priorityScore` (65% impact + 35% frequency) is retained alongside this
// value on every API row; only the Priority Matrix ranking authority
// changes.

export interface ActionabilityInput {
  impact_score: number
  frequency_count: number
  error_code?: string | null
  repro_markers?: number
  source_diversity?: number
}

export function computeActionability(input: ActionabilityInput): number {
  const impact = Math.max(0, Number(input.impact_score) || 0)
  const frequency = Math.max(0, Number(input.frequency_count) || 0)
  const repro = Math.max(0, Number(input.repro_markers) || 0)
  const sourceDiversity = Math.max(1, Number(input.source_diversity) || 1)

  const raw =
    0.55 * Math.min(impact / 10, 1) +
    0.20 * Math.min(frequency / 10, 1) +
    0.10 * (input.error_code ? 1 : 0) +
    0.08 * Math.min(repro / 3, 1) +
    0.07 * Math.min(Math.max(sourceDiversity - 1, 0) / 3, 1)

  // Clamp defensively — the weight sum is exactly 1.0 and every term is
  // normalized to [0,1], so `raw` is already in [0,1]. The clamp is belt-
  // and-braces in case a caller passes an already-normalized `impact` > 10.
  return Number(Math.max(0, Math.min(raw, 1)).toFixed(4))
}

// Breakdown-per-term, used by the Priority Matrix tooltip so the analyst
// can read *why* a cluster ranks where it does. The return shape matches
// the weights so totals align with `computeActionability`.
export function computeActionabilityBreakdown(input: ActionabilityInput) {
  const impact = Math.max(0, Number(input.impact_score) || 0)
  const frequency = Math.max(0, Number(input.frequency_count) || 0)
  const repro = Math.max(0, Number(input.repro_markers) || 0)
  const sourceDiversity = Math.max(1, Number(input.source_diversity) || 1)

  return {
    impact: Number((0.55 * Math.min(impact / 10, 1)).toFixed(4)),
    frequency: Number((0.20 * Math.min(frequency / 10, 1)).toFixed(4)),
    error_code: Number((0.10 * (input.error_code ? 1 : 0)).toFixed(4)),
    repro_markers: Number((0.08 * Math.min(repro / 3, 1)).toFixed(4)),
    source_diversity: Number(
      (0.07 * Math.min(Math.max(sourceDiversity - 1, 0) / 3, 1)).toFixed(4),
    ),
  }
}
