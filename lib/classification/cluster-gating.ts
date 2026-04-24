// Pure gating helpers used by /api/clusters/rollup to decide whether a
// given cluster statistic is well-sampled enough to render on the V3
// card. Kept free of Supabase / React / lucide imports so `node --test
// --experimental-strip-types` can load the file directly and verify the
// honesty invariants.
//
// All thresholds come from rollup-constants.ts so tuning is one place.

import {
  MIN_CLASSIFIED_SHARE_FOR_SEVERITY,
  MIN_CLUSTER_SIZE_FOR_SENTIMENT_PCT,
  MIN_PRIOR_WINDOW_FOR_SURGE,
} from "./rollup-constants.ts"

export type Severity = "low" | "medium" | "high" | "critical"
export interface SeverityDistribution {
  low: number
  medium: number
  high: number
  critical: number
}
export interface SentimentDistribution {
  positive: number
  neutral: number
  negative: number
}

/**
 * Returns the argmax of a severity distribution, or null when the
 * classified share of the cluster is below `MIN_CLASSIFIED_SHARE_FOR_SEVERITY`.
 * Tie-breaks toward the more severe label.
 */
export function dominantSeverity(
  distribution: SeverityDistribution,
  severityLabelledCount: number,
  classifiedShare: number,
): Severity | null {
  if (severityLabelledCount === 0) return null
  if (classifiedShare < MIN_CLASSIFIED_SHARE_FOR_SEVERITY) return null
  const entries: Array<[Severity, number]> = [
    ["critical", distribution.critical],
    ["high", distribution.high],
    ["medium", distribution.medium],
    ["low", distribution.low],
  ]
  let best = entries[0]
  for (const e of entries) if (e[1] > best[1]) best = e
  return best[1] > 0 ? best[0] : null
}

/**
 * Returns an integer percentage of negative-labeled observations, or
 * null when the cluster has fewer than `MIN_CLUSTER_SIZE_FOR_SENTIMENT_PCT`
 * sentiment-labeled rows — below that a single report flips the ratio.
 */
export function negativeSentimentPct(
  distribution: SentimentDistribution,
  sentimentLabelledCount: number,
): number | null {
  if (sentimentLabelledCount < MIN_CLUSTER_SIZE_FOR_SENTIMENT_PCT) return null
  const pct = (distribution.negative / sentimentLabelledCount) * 100
  return Math.round(pct)
}

/**
 * Returns a signed integer percentage delta between `recent` and `prior`
 * counts, rounded to the nearest whole percent. Returns null when the
 * prior-window denominator is below `MIN_PRIOR_WINDOW_FOR_SURGE` — under
 * that, the percentage is statistical noise, not a surge.
 */
export function surgeDeltaPct(recent: number, prior: number): number | null {
  if (prior < MIN_PRIOR_WINDOW_FOR_SURGE) return null
  const pct = ((recent - prior) / prior) * 100
  return Math.round(pct)
}
