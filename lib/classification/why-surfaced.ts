// Pure composer for the V3 card's "why surfaced" sentence. Lives in
// lib/classification/ (no JSX, relative-only imports) so node --test can
// load it under --experimental-strip-types and verify the clause-selection
// invariants without standing up a Supabase client.
//
// Composition rules (see docs/ARCHITECTURE.md §3 dashboard UX doctrine):
//   - Every clause must be backed by a real cluster number. No fabricated
//     phrasing like "escalating observations" — that implies a per-
//     observation label we don't track.
//   - Gating lives upstream in the API route. This module trusts the
//     inputs; e.g. it won't refuse to render a severity clause when
//     classified_share is low, because the route is expected to set
//     `dominant_severity = null` in that case.
//   - Thresholds come from rollup-constants.ts so tuning is one place.
//   - When no clause is loud enough, the caller gets `null` and falls
//     back to its legacy 4-rule decision tree so no UI regresses.

import {
  MIN_AVG_IMPACT_FOR_NARRATIVE,
  MIN_NEGATIVE_SENTIMENT_PCT_FOR_NARRATIVE,
  SURGE_NARRATIVE_THRESHOLD_PCT,
} from "./rollup-constants.ts"

export interface WhySurfacedInput {
  avg_impact: number | null | undefined
  dominant_severity: "low" | "medium" | "high" | "critical" | null | undefined
  negative_sentiment_pct: number | null | undefined
  surge_delta_pct: number | null | undefined
  surge_window_hours: number | null | undefined
  review_pressure_input: number | null | undefined
}

/**
 * Returns a composed sentence, or `null` when no clause crosses its
 * threshold. Caller is responsible for substituting a legacy fallback
 * in the `null` case so the card never renders an empty narrative.
 */
export function composeWhySurfaced(input: WhySurfacedInput): string | null {
  const clauses: Array<{ strength: number; text: string }> = []

  // Surge delta — loudest signal. Phrase absolute value so both "+340%"
  // and "-60% decay" read naturally.
  if (
    input.surge_delta_pct != null &&
    Math.abs(input.surge_delta_pct) >= SURGE_NARRATIVE_THRESHOLD_PCT
  ) {
    const windowHours = input.surge_window_hours ?? 6
    const sign = input.surge_delta_pct > 0 ? "+" : ""
    clauses.push({
      strength: Math.abs(input.surge_delta_pct),
      text: `${sign}${Math.round(input.surge_delta_pct)}% volume change in the last ${windowHours} hours`,
    })
  }

  // Dominant severity — only "high" and "critical" warrant surfacing.
  // "medium" and "low" don't explain why a cluster got ranked up.
  if (input.dominant_severity === "critical") {
    clauses.push({ strength: 90, text: "dominant critical severity" })
  } else if (input.dominant_severity === "high") {
    clauses.push({ strength: 70, text: "dominant high severity" })
  }

  // Negative sentiment majority.
  if (
    input.negative_sentiment_pct != null &&
    input.negative_sentiment_pct >= MIN_NEGATIVE_SENTIMENT_PCT_FOR_NARRATIVE
  ) {
    clauses.push({
      strength: input.negative_sentiment_pct,
      text: `${Math.round(input.negative_sentiment_pct)}% negative sentiment`,
    })
  }

  // Avg impact — baseline actionability signal.
  if (
    input.avg_impact != null &&
    input.avg_impact >= MIN_AVG_IMPACT_FOR_NARRATIVE
  ) {
    clauses.push({
      strength: input.avg_impact * 10,
      text: `${formatImpact(input.avg_impact)} avg impact`,
    })
  }

  // Review pressure — volume of unreviewed classifications.
  if (input.review_pressure_input != null && input.review_pressure_input >= 5) {
    clauses.push({
      strength: Math.min(60, input.review_pressure_input * 2),
      text: `${input.review_pressure_input} unreviewed`,
    })
  }

  if (clauses.length === 0) return null

  // Pick top 3 by strength, preserve a stable display order (strongest
  // first) so identical inputs always render the same sentence.
  const picked = clauses.sort((a, b) => b.strength - a.strength).slice(0, 3)
  const sentence = picked.map((c) => c.text).join(", ")
  return `${sentence}.`
}

// Single decimal, no trailing zero. Impact scores live on a 0-10 scale
// with one decimal of precision (see docs/SCORING.md §10.1).
function formatImpact(v: number): string {
  const rounded = Math.round(v * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}
