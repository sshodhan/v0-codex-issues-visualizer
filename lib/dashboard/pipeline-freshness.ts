// Pure derivation for the dashboard's pipeline-freshness strip. Lives in
// lib/dashboard/ (no JSX) so it is unit-testable under node --test with
// --experimental-strip-types — matches the convention of
// story-category-atlas-layout.ts + .test.ts in this directory.
//
// The strip's contract: NEVER render a healthy-looking surface when the
// inputs aren't confidently healthy. The state machine below is the single
// source of truth for that; the React component is a thin renderer over
// the view model returned by `derivePipelineFreshness`.
//
// Related:
//   - lib/classification/prerequisites.ts (PrerequisiteStatus shape + CTA
//     picker for partially-caught-up pipelines)
//   - components/dashboard/pipeline-freshness-strip.tsx (renderer)

import { pickPrimaryCta, type PrerequisiteStatus } from "../classification/prerequisites.ts"
import { MIN_IMPACT_SCORE } from "../classification/run-backfill-constants.ts"

export type PipelineFreshnessState =
  | "healthy"
  | "empty"
  | "degraded"
  | "failure"
  | "unknown"

/**
 * Machine-readable reason code for the state. Stable string enum — useful
 * for analytics, logs, and tests. Human copy lives in `headline` / `subtext`.
 */
export type PipelineFreshnessReason =
  | "loading"
  | "stats-endpoint-errored"
  | "prereq-null"
  | "last-scrape-failed"
  | "openai-key-missing"
  | "classify-backfill-failed"
  | "pending-classification"
  | "pending-clustering"
  | "pending-classification-and-clustering"
  | "no-observations-in-window"
  | "all-caught-up"

/** Per-metric display descriptor. `value` is `null` when the input is
 *  missing; the renderer MUST show an explicit placeholder rather than a
 *  healthy-looking fallback (e.g. "100%" or "0"). */
export interface MetricDisplay {
  label: string
  /** Pre-formatted value string (e.g. "3 / 5 (60%)"), or `null` when missing. */
  value: string | null
  /** Tone hint for the renderer — `"unknown"` forces italic-muted styling. */
  status: "ok" | "attention" | "failure" | "unknown" | "neutral"
}

export interface PipelineFreshnessViewModel {
  state: PipelineFreshnessState
  reason: PipelineFreshnessReason
  headline: string
  /** Null when the state needs no sub-copy (keeps the strip terse when healthy). */
  subtext: string | null
  /** Deep-link CTA into /admin when there's an actionable next step. */
  cta: { href: string; label: string } | null
  /** Flags the renderer uses to show secondary chips without reasoning again. */
  flags: {
    lastClassifyBackfillFailed: boolean
  }
  metrics: {
    lastScrape: MetricDisplay
    clustered: MetricDisplay
    classified: MetricDisplay
    pendingReview: MetricDisplay
  }
}

export interface PipelineFreshnessInputs {
  /**
   * `undefined` = prerequisite fetch is still loading (SWR pre-first-response).
   * `null`      = server returned a payload with no prereqs (computePrerequisites
   *               caught an error — see app/api/classifications/stats/route.ts).
   * Kept distinct because an in-flight fetch must not surface as "failed".
   */
  prereq: PrerequisiteStatus | null | undefined
  /** needs_human_review count from /api/classifications/stats. */
  pendingReviewCount: number | null | undefined
  /** SWR isError flag from the stats hook. Outranks prereq presence. */
  statsError: boolean
  /** Current window label (e.g. "Last 30 days"). Used in subtext. */
  windowLabel: string
  /** Optional: function to format timestamps, so tests can be deterministic. */
  formatTimestamp?: (iso: string) => string
  /** Optional: `now()` override so freshness SLA tests are deterministic. */
  now?: () => Date
  /**
   * Freshness SLA in minutes. If the last scrape completed more than this
   * long ago (and otherwise healthy), we downgrade to `degraded`. Matches
   * the hourly scrape cron: 120 min = two missed runs.
   */
  freshnessSlaMinutes?: number
}

const DEFAULT_FRESHNESS_SLA_MINUTES = 120

export function derivePipelineFreshness(
  inputs: PipelineFreshnessInputs,
): PipelineFreshnessViewModel {
  const {
    prereq,
    pendingReviewCount,
    statsError,
    windowLabel,
    formatTimestamp = defaultFormatTimestamp,
    now = () => new Date(),
    freshnessSlaMinutes = DEFAULT_FRESHNESS_SLA_MINUTES,
  } = inputs

  const metrics = buildMetrics({ prereq, pendingReviewCount, formatTimestamp })

  // Error from SWR outranks every other signal. A failing stats endpoint
  // must never masquerade as unknown-but-benign.
  if (statsError) {
    return {
      state: "failure",
      reason: "stats-endpoint-errored",
      headline: "Pipeline health feed failed",
      subtext:
        "The /api/classifications/stats endpoint returned an error. Metrics below are best-effort only.",
      cta: { href: "/admin", label: "Open admin" },
      flags: { lastClassifyBackfillFailed: false },
      metrics,
    }
  }

  if (prereq === undefined) {
    return {
      state: "unknown",
      reason: "loading",
      headline: "Pipeline status unavailable",
      subtext: "Checking scrape, clustering, and classification readiness…",
      cta: null,
      flags: { lastClassifyBackfillFailed: false },
      metrics,
    }
  }

  if (prereq === null) {
    return {
      state: "unknown",
      reason: "prereq-null",
      headline: "Pipeline status unavailable",
      subtext:
        "Server returned no prerequisite block. Check server logs — metrics below may be stale.",
      cta: { href: "/admin", label: "Open admin" },
      flags: { lastClassifyBackfillFailed: false },
      metrics,
    }
  }

  const lastClassifyBackfillFailed =
    prereq.lastClassifyBackfill.status === "failed"

  if (prereq.lastScrape.status === "failed") {
    return {
      state: "failure",
      reason: "last-scrape-failed",
      headline: "Last scrape failed",
      subtext: `The most recent scrape run ended in a failure state. Data in ${windowLabel} may be stale.`,
      cta: { href: "/admin", label: "Investigate in admin" },
      flags: { lastClassifyBackfillFailed },
      metrics,
    }
  }

  if (!prereq.openaiConfigured && prereq.observationsInWindow > 0) {
    return {
      state: "failure",
      reason: "openai-key-missing",
      headline: "OpenAI API key missing — classify pipeline cannot run",
      subtext:
        "Classifications will 503 until OPENAI_API_KEY is set in project env. Existing data shown as-is.",
      cta: { href: "/admin", label: "Configure OpenAI key" },
      flags: { lastClassifyBackfillFailed },
      metrics,
    }
  }

  if (prereq.observationsInWindow === 0) {
    return {
      state: "empty",
      reason: "no-observations-in-window",
      headline: "No issues in this window",
      subtext: `Pipeline is caught up, but 0 observations fall inside ${windowLabel}. Widen the time range or trigger a scrape.`,
      cta: null,
      flags: { lastClassifyBackfillFailed },
      metrics,
    }
  }

  if (
    prereq.pendingClassification > 0 ||
    prereq.pendingClustering > 0 ||
    lastClassifyBackfillFailed
  ) {
    const reason: PipelineFreshnessReason =
      prereq.pendingClassification > 0 && prereq.pendingClustering > 0
        ? "pending-classification-and-clustering"
        : prereq.pendingClassification > 0
          ? "pending-classification"
          : prereq.pendingClustering > 0
            ? "pending-clustering"
            : "classify-backfill-failed"

    const parts: string[] = []
    if (prereq.pendingClassification > 0) {
      // When `highImpactPendingClassification` is provided and differs
      // from the raw pending count, split the message so the reviewer
      // understands that "Run classify-backfill" can only work on the
      // high-impact subset. When the two are equal (or only one number
      // is available for an older consumer) fall back to the original
      // single-number phrasing so nothing regresses.
      const high = prereq.highImpactPendingClassification
      if (high > 0 && high < prereq.pendingClassification) {
        parts.push(
          `${prereq.pendingClassification} awaiting classification (${high} high-impact)`,
        )
      } else if (high === 0 && prereq.pendingClassification > 0) {
        parts.push(
          `${prereq.pendingClassification} awaiting classification (all below impact-${MIN_IMPACT_SCORE} threshold)`,
        )
      } else {
        parts.push(`${prereq.pendingClassification} awaiting classification`)
      }
    }
    if (prereq.pendingClustering > 0) {
      parts.push(`${prereq.pendingClustering} awaiting clustering`)
    }
    if (lastClassifyBackfillFailed) {
      parts.push("last classify-backfill failed")
    }

    const primary = pickPrimaryCta(prereq)
    let cta: { href: string; label: string } | null =
      primary.kind === "classify-backfill" || primary.kind === "clustering"
        ? { href: primary.href, label: primary.label }
        : primary.kind === "openai-missing"
          ? { href: "/admin", label: "Configure OpenAI key" }
          : null
    // When every pending row is below the impact threshold there's still
    // value in pointing the reviewer at the admin panel — they can see
    // the policy, lower the threshold, or confirm the deferral is
    // intentional. `pickPrimaryCta` now returns `{ kind: "none" }` in
    // that case (it used to return a "Run classify-backfill" CTA that
    // did nothing); substitute a "View classify-backfill policy" link so
    // the strip still has an actionable next step.
    if (
      !cta &&
      prereq.pendingClassification > 0 &&
      prereq.highImpactPendingClassification === 0 &&
      prereq.openaiConfigured
    ) {
      cta = {
        href: "/admin?tab=classify-backfill",
        label: "View classify-backfill policy",
      }
    }
    // Fallback: `pickPrimaryCta` returns `{ kind: "none" }` when nothing is
    // pending, but a failed classify-backfill run still puts us in the
    // degraded state above — and the user still needs a way to retry. Link
    // to the classify-backfill admin tab so there is always an actionable
    // next step for a non-healthy state. See invariant test:
    // "failure and degraded states surface a CTA".
    if (!cta && lastClassifyBackfillFailed) {
      cta = { href: "/admin?tab=classify-backfill", label: "Retry classify-backfill" }
    }

    return {
      state: "degraded",
      reason,
      headline: "Pipeline not caught up",
      subtext:
        parts.length > 0
          ? `${parts.join(" · ")}. Numbers below are a partial view until backlog clears.`
          : "Some pipeline steps are behind; numbers below are a partial view.",
      cta,
      flags: { lastClassifyBackfillFailed },
      metrics,
    }
  }

  // Freshness SLA: downgrade a caught-up pipeline to `degraded` when the
  // last scrape is older than the configured SLA. An "all green" strip on
  // day-old data is exactly the failure mode this feature was asked to
  // prevent.
  if (
    isLastScrapeStale({
      at: prereq.lastScrape.at,
      now: now(),
      slaMinutes: freshnessSlaMinutes,
    })
  ) {
    const ageMinutes = minutesSince(prereq.lastScrape.at, now())
    return {
      state: "degraded",
      reason: "pending-classification",
      headline: "Pipeline may be stale",
      subtext: `Last scrape completed ${ageMinutes != null ? `${ageMinutes} min ago` : "more than an SLA window ago"}; exceeded ${freshnessSlaMinutes}-min freshness SLA.`,
      cta: { href: "/admin", label: "Investigate in admin" },
      flags: { lastClassifyBackfillFailed },
      metrics,
    }
  }

  return {
    state: "healthy",
    reason: "all-caught-up",
    headline: "Pipeline caught up",
    subtext: `${prereq.classifiedCount}/${prereq.observationsInWindow} classified · ${prereq.clusteredCount}/${prereq.observationsInWindow} clustered in ${windowLabel}.`,
    cta: null,
    flags: { lastClassifyBackfillFailed },
    metrics,
  }
}

function buildMetrics({
  prereq,
  pendingReviewCount,
  formatTimestamp,
}: {
  prereq: PrerequisiteStatus | null | undefined
  pendingReviewCount: number | null | undefined
  formatTimestamp: (iso: string) => string
}): PipelineFreshnessViewModel["metrics"] {
  const isLoading = prereq === undefined
  const lastScrapeAt = prereq?.lastScrape.at ?? null
  const lastScrapeStatus = prereq?.lastScrape.status ?? null

  const lastScrape: MetricDisplay = {
    label: "Last scrape",
    value: lastScrapeAt ? safeFormat(lastScrapeAt, formatTimestamp) : null,
    status:
      lastScrapeStatus === "failed"
        ? "failure"
        : isLoading
          ? "unknown"
          : "neutral",
  }

  const clustered = ratioMetric({
    label: "Clustered",
    have: prereq?.clusteredCount,
    total: prereq?.observationsInWindow,
    isLoading,
  })
  const classified = ratioMetric({
    label: "Classified",
    have: prereq?.classifiedCount,
    total: prereq?.observationsInWindow,
    isLoading,
  })

  const pendingReview: MetricDisplay = {
    label: "Needs review",
    value:
      pendingReviewCount === null || pendingReviewCount === undefined
        ? null
        : `${pendingReviewCount} high-impact`,
    status:
      pendingReviewCount === undefined || pendingReviewCount === null
        ? "unknown"
        : pendingReviewCount > 0
          ? "attention"
          : "ok",
  }

  return { lastScrape, clustered, classified, pendingReview }
}

function ratioMetric({
  label,
  have,
  total,
  isLoading,
}: {
  label: string
  have: number | null | undefined
  total: number | null | undefined
  isLoading: boolean
}): MetricDisplay {
  if (have === undefined || total === undefined || have === null || total === null) {
    return { label, value: null, status: isLoading ? "unknown" : "unknown" }
  }
  // Explicit 0/0 — we refuse to render 100% when the denominator is 0,
  // per the prompt's anti-pattern rule.
  if (total === 0) {
    return { label, value: "0 / 0", status: "unknown" }
  }
  const pct = Math.round((have / total) * 100)
  const status: MetricDisplay["status"] = have >= total ? "ok" : "attention"
  return { label, value: `${have} / ${total} (${pct}%)`, status }
}

function safeFormat(iso: string, formatTimestamp: (iso: string) => string): string | null {
  try {
    return formatTimestamp(iso)
  } catch {
    return null
  }
}

function defaultFormatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error("invalid date")
  const diffMs = Date.now() - d.getTime()
  const mins = Math.round(diffMs / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} d ago`
}

function minutesSince(at: string | null, now: Date): number | null {
  if (!at) return null
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return null
  return Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000))
}

function isLastScrapeStale({
  at,
  now,
  slaMinutes,
}: {
  at: string | null
  now: Date
  slaMinutes: number
}): boolean {
  const mins = minutesSince(at, now)
  if (mins === null) return false
  return mins > slaMinutes
}
