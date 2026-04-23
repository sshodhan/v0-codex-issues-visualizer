/** Copy aligned with docs/SCORING.md §8 and docs/ARCHITECTURE.md. */

export const INTERPRETATION_BULLETS = [
  "Do not use raw post count alone to decide what is urgent. Combine category context, how negative the tone is, and impact (see SCORING.md §8 for written-summary guidance).",
  "The hero and realtime list use the runtime `urgencyScore` from `lib/analytics/realtime.ts` — not a separate or fabricated value.",
  "Representative issues show up to three sample rows with links when the source provided a URL. The full table for your selected days is below.",
] as const

export const URGENCY_FORMULA_MARKDOWN = `Urgency rank blends (see lib/analytics/realtime.ts):
decayed recent volume (×1.6) + max(momentum, 0) (×1.4) + average impact (×1.0) + (sources − 1) (×0.8), then categories are sorted by this score.`

export const FINGERPRINT_VS_LLM_BULLETS = [
  "Fingerprints are deterministic (regex) signals from title and body: error codes, stack hints, and env tokens. They make similar reports with different root causes look different quickly.",
  "LLM classifications (AI Classifications tab) are a separate layer and are not merged into the regex fingerprint. Both can appear in SignalLayers for the same observation.",
  "The compound key filter matches cluster_key_compound; it is a read-time slice, not a change to cluster membership.",
] as const
