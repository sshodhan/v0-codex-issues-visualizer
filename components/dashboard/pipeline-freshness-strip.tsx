"use client"

import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  HelpCircle,
  XCircle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { pickPrimaryCta, type PrerequisiteStatus } from "@/lib/classification/prerequisites"

// Persistent pipeline-freshness strip. Distinguishes "no issues yet" from
// "pipeline not caught up" from "data stale / failing" so a viewer never
// misreads a quiet board as a healthy board.
//
// Tone rubric (the ONLY legal states):
//   unknown  — prereq fetch is loading or server returned null. Explicit copy,
//              no implicit "all green".
//   failure  — last scrape run failed, OR prereqs missing and stats error.
//   degraded — observations exist but classify/cluster are behind, OR last
//              classify-backfill failed. Admin CTA rendered.
//   empty    — pipeline caught up, but 0 observations in the current window.
//              This is the "no issues" surface — called out explicitly so
//              nobody confuses it with "pipeline hasn't run".
//   healthy  — observations exist and classify + cluster are at 100%.
//
// NB: "pending high-impact review" is sourced from the classification stats
// needsReviewCount (the audit queue count used by the tab badge). When the
// stats endpoint is still loading we render "—" rather than 0 — a zero here
// would look reassuring while meaning "we didn't ask yet".
//
// Rendered from app/page.tsx (dashboard + triage) and referenced here as a
// persistent surface, NOT only inside empty states (see task spec step 3).

export type PipelineFreshnessTone =
  | "unknown"
  | "failure"
  | "degraded"
  | "empty"
  | "healthy"

interface PipelineFreshnessStripProps {
  /** `null` = server returned null (prereqs fetch failed). `undefined` = still loading. */
  prereq: PrerequisiteStatus | null | undefined
  /** Needs-human-review count from /api/classifications/stats. `undefined` = still loading. */
  pendingReviewCount: number | undefined
  /** `true` = the /api/classifications/stats fetch errored out. */
  statsError?: boolean
  /** Context label (e.g. "Last 30 days" or "All time") so the ratios are anchored. */
  windowLabel: string
  /** When set, shows "as-of replay" banner with a link back to live. */
  asOfActive?: boolean
  className?: string
}

export function PipelineFreshnessStrip({
  prereq,
  pendingReviewCount,
  statsError = false,
  windowLabel,
  asOfActive = false,
  className,
}: PipelineFreshnessStripProps) {
  const tone = decideTone({ prereq, statsError })

  const classified = ratio(prereq?.classifiedCount, prereq?.observationsInWindow)
  const clustered = ratio(prereq?.clusteredCount, prereq?.observationsInWindow)
  const lastScrapeLabel = formatMaybeDate(prereq?.lastScrape.at)
  const lastScrapeStatus = prereq?.lastScrape.status ?? null
  const lastBackfillStatus = prereq?.lastClassifyBackfill.status ?? null

  const { headline, subtext, cta } = describe({
    tone,
    prereq: prereq ?? null,
    statsError,
    windowLabel,
  })

  const toneStyles = getToneStyles(tone)

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col gap-2 rounded-md border px-3 py-2 text-sm ${toneStyles.container} ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className={`mt-0.5 flex-shrink-0 ${toneStyles.icon}`}>
          <ToneIcon tone={tone} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{headline}</p>
          {subtext && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{subtext}</p>
          )}
        </div>
        <Badge variant="outline" className={`text-[10px] font-mono uppercase ${toneStyles.badge}`}>
          {tone}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        <MetricCell
          label="Last scrape"
          value={lastScrapeLabel}
          status={lastScrapeStatus === "failed" ? "failure" : "neutral"}
          missingText="no record"
        />
        <MetricCell
          label="Clustered"
          value={classified == null || clustered == null ? null : clustered.label}
          status={clustered?.status ?? (prereq === undefined ? "unknown" : "unknown")}
          missingText={prereq === undefined ? "loading" : "unknown"}
        />
        <MetricCell
          label="Classified"
          value={classified?.label ?? null}
          status={classified?.status ?? (prereq === undefined ? "unknown" : "unknown")}
          missingText={prereq === undefined ? "loading" : "unknown"}
        />
        <MetricCell
          label="Needs review"
          value={
            pendingReviewCount === undefined
              ? null
              : `${pendingReviewCount} high-impact`
          }
          status={
            pendingReviewCount === undefined
              ? "unknown"
              : pendingReviewCount > 0
                ? "attention"
                : "ok"
          }
          missingText="loading"
        />
      </div>

      {(lastBackfillStatus === "failed" || asOfActive || cta) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {lastBackfillStatus === "failed" && (
            <span className="inline-flex items-center gap-1 text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              Last classify-backfill run: failed
            </span>
          )}
          {asOfActive && (
            <span className="text-muted-foreground">
              Historical replay active.{" "}
              <Link
                href="/"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Return to live
              </Link>
            </span>
          )}
          {cta && (
            <a
              href={cta.href}
              className={`ml-auto inline-flex items-center gap-1 font-medium hover:underline ${toneStyles.ctaLink}`}
            >
              {cta.label}
              <ArrowRight className="h-3 w-3" />
            </a>
          )}
          <span className="text-muted-foreground">Window: {windowLabel}</span>
        </div>
      )}

      {!(lastBackfillStatus === "failed" || asOfActive || cta) && (
        <p className="text-xs text-muted-foreground">Window: {windowLabel}</p>
      )}
    </div>
  )
}

function ToneIcon({ tone }: { tone: PipelineFreshnessTone }) {
  switch (tone) {
    case "healthy":
      return <CheckCircle2 className="h-4 w-4" aria-hidden />
    case "empty":
      return <CircleDashed className="h-4 w-4" aria-hidden />
    case "degraded":
      return <AlertTriangle className="h-4 w-4" aria-hidden />
    case "failure":
      return <XCircle className="h-4 w-4" aria-hidden />
    case "unknown":
      return <HelpCircle className="h-4 w-4" aria-hidden />
  }
}

function MetricCell({
  label,
  value,
  status,
  missingText,
}: {
  label: string
  value: string | null
  status: "ok" | "attention" | "failure" | "unknown" | "neutral"
  missingText: string
}) {
  const valueTone =
    status === "failure"
      ? "text-destructive"
      : status === "attention"
        ? "text-amber-600 dark:text-amber-400"
        : status === "unknown"
          ? "text-muted-foreground italic"
          : "text-foreground"
  return (
    <div className="flex flex-col">
      <span className="uppercase tracking-wide text-[10px] opacity-70">{label}</span>
      <span className={`text-xs font-medium tabular-nums ${valueTone}`}>
        {value ?? missingText}
      </span>
    </div>
  )
}

function decideTone({
  prereq,
  statsError,
}: {
  prereq: PrerequisiteStatus | null | undefined
  statsError: boolean
}): PipelineFreshnessTone {
  // An explicit fetch error outranks the loading-vs-null distinction: a
  // failing stats endpoint must never look like an unknown-but-benign state.
  if (statsError) return "failure"
  if (prereq === undefined) return "unknown"
  if (prereq === null) return "unknown"

  if (prereq.lastScrape.status === "failed") return "failure"
  if (!prereq.openaiConfigured && prereq.observationsInWindow > 0) return "failure"

  if (prereq.observationsInWindow === 0) return "empty"

  if (prereq.pendingClassification > 0 || prereq.pendingClustering > 0) {
    return "degraded"
  }
  if (prereq.lastClassifyBackfill.status === "failed") return "degraded"

  return "healthy"
}

function describe({
  tone,
  prereq,
  statsError,
  windowLabel,
}: {
  tone: PipelineFreshnessTone
  prereq: PrerequisiteStatus | null
  statsError: boolean
  windowLabel: string
}): {
  headline: string
  subtext: string | null
  cta: { href: string; label: string } | null
} {
  if (tone === "unknown") {
    return {
      headline: "Pipeline status unavailable",
      subtext: statsError
        ? "We couldn't load the pipeline health feed. Numbers below may be out of date."
        : "Checking scrape, clustering, and classification readiness…",
      cta: null,
    }
  }

  if (tone === "failure") {
    if (!prereq) {
      return {
        headline: "Pipeline health feed failed",
        subtext:
          "The /api/classifications/stats prerequisite block returned null. Check server logs — the numbers below are best-effort only.",
        cta: { href: "/admin", label: "Open admin" },
      }
    }
    if (!prereq.openaiConfigured) {
      return {
        headline: "OpenAI API key missing — classify pipeline cannot run",
        subtext:
          "Classifications will 503 until OPENAI_API_KEY is set in the project env. Existing data is shown as-is.",
        cta: { href: "/admin", label: "Open admin" },
      }
    }
    return {
      headline: "Last scrape failed",
      subtext: `The most recent scrape run ended in a failure state. Data in ${windowLabel} may be stale.`,
      cta: { href: "/admin", label: "Investigate in admin" },
    }
  }

  if (tone === "empty") {
    return {
      headline: "No issues in this window",
      subtext: `Pipeline is caught up, but 0 observations fall inside ${windowLabel}. Widen the time range or trigger a scrape.`,
      cta: null,
    }
  }

  if (tone === "degraded" && prereq) {
    const cta = pickPrimaryCta(prereq)
    const parts: string[] = []
    if (prereq.pendingClassification > 0) {
      parts.push(`${prereq.pendingClassification} awaiting classification`)
    }
    if (prereq.pendingClustering > 0) {
      parts.push(`${prereq.pendingClustering} awaiting clustering`)
    }
    if (prereq.lastClassifyBackfill.status === "failed") {
      parts.push("last classify-backfill failed")
    }
    return {
      headline: "Pipeline not caught up",
      subtext: parts.length > 0
        ? `${parts.join(" · ")}. Numbers below are a partial view until backlog clears.`
        : "Some pipeline steps are behind; numbers below are a partial view.",
      cta:
        cta.kind === "classify-backfill" || cta.kind === "clustering"
          ? { href: cta.href, label: cta.label }
          : cta.kind === "openai-missing"
            ? { href: "/admin", label: "Configure OpenAI key" }
            : null,
    }
  }

  // healthy
  return {
    headline: "Pipeline caught up",
    subtext: prereq
      ? `${prereq.classifiedCount}/${prereq.observationsInWindow} classified · ${prereq.clusteredCount}/${prereq.observationsInWindow} clustered in ${windowLabel}.`
      : null,
    cta: null,
  }
}

function ratio(
  have: number | null | undefined,
  total: number | null | undefined,
): { label: string; status: "ok" | "attention" | "unknown" } | null {
  if (have === undefined || total === undefined) return null
  if (have === null || total === null) return null
  if (total === 0) return { label: "0 / 0", status: "unknown" }
  const pct = Math.round((have / total) * 100)
  const status = have >= total ? "ok" : "attention"
  return { label: `${have} / ${total} (${pct}%)`, status }
}

function formatMaybeDate(at: string | null | undefined): string | null {
  if (at === undefined) return null
  if (at === null) return null
  try {
    return formatDistanceToNow(new Date(at), { addSuffix: true })
  } catch {
    return null
  }
}

function getToneStyles(tone: PipelineFreshnessTone): {
  container: string
  icon: string
  badge: string
  ctaLink: string
} {
  switch (tone) {
    case "healthy":
      return {
        container: "border-emerald-500/30 bg-emerald-500/5",
        icon: "text-emerald-600 dark:text-emerald-400",
        badge: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
        ctaLink: "text-primary",
      }
    case "empty":
      return {
        container: "border-border bg-muted/20",
        icon: "text-muted-foreground",
        badge: "border-border text-muted-foreground",
        ctaLink: "text-primary",
      }
    case "degraded":
      return {
        container: "border-amber-500/40 bg-amber-500/5",
        icon: "text-amber-600 dark:text-amber-400",
        badge: "border-amber-500/40 text-amber-700 dark:text-amber-300",
        ctaLink: "text-amber-700 dark:text-amber-300",
      }
    case "failure":
      return {
        container: "border-destructive/40 bg-destructive/5",
        icon: "text-destructive",
        badge: "border-destructive/40 text-destructive",
        ctaLink: "text-destructive",
      }
    case "unknown":
      return {
        container: "border-dashed border-border bg-muted/10",
        icon: "text-muted-foreground",
        badge: "border-border text-muted-foreground",
        ctaLink: "text-primary",
      }
  }
}
