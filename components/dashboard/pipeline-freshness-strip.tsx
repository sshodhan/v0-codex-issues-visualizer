"use client"

import { useState } from "react"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  ChevronDown,
  HelpCircle,
  XCircle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import type { PrerequisiteStatus } from "@/lib/classification/prerequisites"
import {
  derivePipelineFreshness,
  type MetricDisplay,
  type PipelineFreshnessState,
  type PipelineFreshnessViewModel,
} from "@/lib/dashboard/pipeline-freshness"

// Thin renderer over `derivePipelineFreshness`. All state decisions live
// in lib/dashboard/pipeline-freshness.ts so the logic is unit-testable
// without a React runtime. This file only owns visual concerns
// (tone → class, icon, badge styling).
//
// Persistent by design: mounted ABOVE the loading/error/empty branching
// in app/page.tsx so "no issues" vs "pipeline not caught up" is visible
// in every state and across dashboard + triage tabs (see task spec §3).

interface PipelineFreshnessStripProps {
  /** `null` = server returned null (prereqs fetch failed). `undefined` = still loading. */
  prereq: PrerequisiteStatus | null | undefined
  /** needs_human_review count from /api/classifications/stats. `undefined` = still loading. */
  pendingReviewCount: number | undefined
  /** `true` when the /api/classifications/stats fetch errored out. */
  statsError?: boolean
  /** Context label (e.g. "Last 30 days" or "All time") so ratios are anchored. */
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
  const [isOpen, setIsOpen] = useState(false)
  
  const vm = derivePipelineFreshness({
    prereq,
    pendingReviewCount,
    statsError,
    windowLabel,
    formatTimestamp: (iso) =>
      formatDistanceToNow(new Date(iso), { addSuffix: true }),
  })

  const toneStyles = getToneStyles(vm.state)
  const ariaLabel = `Pipeline status: ${vm.state}. ${vm.headline}`
  const lastSyncLabel = vm.metrics.lastScrape.value || "Unknown"

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      data-testid="pipeline-freshness-strip"
      data-state={vm.state}
      data-reason={vm.reason}
      className={`rounded-md border ${toneStyles.container} ${className ?? ""}`}
    >
      <CollapsibleTrigger className={`w-full flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-accent/50 transition-colors`}>
        <span className={`mt-0.5 flex-shrink-0 ${toneStyles.icon}`}>
          <ToneIcon state={vm.state} />
        </span>
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-foreground">{vm.headline}</p>
            <span className="text-xs text-muted-foreground">Last sync: {lastSyncLabel}</span>
          </div>
          {vm.subtext && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              {vm.subtext}
            </p>
          )}
        </div>
        <Badge
          variant="outline"
          className={`text-[10px] font-mono uppercase flex-shrink-0 ${toneStyles.badge}`}
        >
          {vm.state}
        </Badge>
        <ChevronDown 
          className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="px-3 pb-2 pt-0 space-y-2">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
          <MetricCell metric={vm.metrics.lastScrape} />
          <MetricCell metric={vm.metrics.clustered} />
          <MetricCell metric={vm.metrics.classified} />
          <MetricCell metric={vm.metrics.pendingReview} />
        </div>

        {(vm.flags.lastClassifyBackfillFailed || asOfActive || vm.cta) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {vm.flags.lastClassifyBackfillFailed && (
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
            {vm.cta && (
              <a
                href={vm.cta.href}
                className={`ml-auto inline-flex items-center gap-1 font-medium hover:underline ${toneStyles.ctaLink}`}
              >
                {vm.cta.label}
                <ArrowRight className="h-3 w-3" />
              </a>
            )}
            <span className="text-muted-foreground">Window: {windowLabel}</span>
          </div>
        )}

        {!(vm.flags.lastClassifyBackfillFailed || asOfActive || vm.cta) && (
          <p className="text-xs text-muted-foreground">Window: {windowLabel}</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export type { PipelineFreshnessViewModel }

function ToneIcon({ state }: { state: PipelineFreshnessState }) {
  switch (state) {
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

function MetricCell({ metric }: { metric: MetricDisplay }) {
  const valueTone =
    metric.status === "failure"
      ? "text-destructive"
      : metric.status === "attention"
        ? "text-amber-600 dark:text-amber-400"
        : metric.status === "unknown"
          ? "text-muted-foreground italic"
          : "text-foreground"
  // Explicit placeholder when value is missing — never a healthy-looking
  // fallback like "100%" or "0". Matches the task's "no silent fallback"
  // rule (see lib/dashboard/pipeline-freshness.ts).
  const displayValue = metric.value ?? "Unavailable"
  return (
    <div className="flex flex-col">
      <span className="uppercase tracking-wide text-[10px] opacity-70">
        {metric.label}
      </span>
      <span
        className={`text-xs font-medium tabular-nums ${valueTone}`}
        aria-label={metric.value ? undefined : `${metric.label}: unavailable`}
      >
        {displayValue}
      </span>
    </div>
  )
}

function getToneStyles(state: PipelineFreshnessState): {
  container: string
  icon: string
  badge: string
  ctaLink: string
} {
  switch (state) {
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
