// Tunables for `/api/clusters/rollup` enrichment.
//
// Kept in a standalone module so tests can import them under
// `--experimental-strip-types` without pulling the Supabase route, and so
// every gating threshold lives in one grep-able place.

// Hours in each surge window. The rollup compares observation counts
// in the last N hours to the prior N hours to compute surge_delta_pct.
//
// Must be at least the scrape cron cadence (every 6 hours per
// vercel.json). Below that, the query reads the same materialized-view
// snapshot twice and always returns 0% — an accurate-looking but
// meaningless number. If the cron is ever tightened to every 2h or 4h,
// drop this value in lockstep.
export const CLUSTER_SURGE_WINDOW_HOURS = 6

// Minimum prior-window count before rendering a percentage. With fewer
// than this many observations in the prior window the denominator is
// too small for the percentage to mean anything (+200% off 1 to 3 is
// noise, not a surge).
export const MIN_PRIOR_WINDOW_FOR_SURGE = 3

// Minimum cluster size before we publish a negative_sentiment_pct.
// Below this, a single observation flips the percentage wildly.
export const MIN_CLUSTER_SIZE_FOR_SENTIMENT_PCT = 3

// Gating ratio for the HIGH SEVERITY / CRITICAL state chip. When less
// than this fraction of a cluster has been classified, dominant
// severity is the dominant severity of the half we have looked at — a
// biased statistic, so we withhold the chip rather than mislead.
export const MIN_CLASSIFIED_SHARE_FOR_SEVERITY = 0.5

// Surge thresholds for the "SURGE DETECTED" chip and the "+N%" why-
// surfaced clause. A +25% swing shows up in the narrative; +50%
// promotes the chip.
export const SURGE_NARRATIVE_THRESHOLD_PCT = 25
export const SURGE_CHIP_THRESHOLD_PCT = 50

// Minimum avg_impact before the impact clause appears in why-surfaced.
// Below this, "X avg impact" isn't a reason a cluster got surfaced —
// it's noise. Matches the MIN_IMPACT_SCORE policy in
// run-backfill-constants.
export const MIN_AVG_IMPACT_FOR_NARRATIVE = 4

// Minimum negative-sentiment ratio (of classified observations) before
// the sentiment clause appears in why-surfaced.
export const MIN_NEGATIVE_SENTIMENT_PCT_FOR_NARRATIVE = 50
