"use client"

import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { SignalTimelineStory } from "@/components/dashboard/signal-timeline-story"
import { buildStoryTimeline, groupCategoriesByCount } from "@/lib/dashboard/story-timeline"
import type { FingerprintSurgeResponse, Issue } from "@/hooks/use-dashboard-data"
import { BookOpen, ArrowDown, ExternalLink, TriangleAlert } from "lucide-react"
import { GlobalFilterBar } from "@/components/dashboard/global-filter-bar"
import { DataProvenanceStrip } from "@/components/dashboard/data-provenance-strip"

type CatOpt = { value: string; label: string; count: number }

interface DashboardStoryViewProps {
  issues: Issue[]
  issuesLoading: boolean
  statsTotalIssues: number
  heroCategoryName: string | null
  heroUrgencyLine: string | null
  fingerprintSurges: FingerprintSurgeResponse | undefined
  windowLabel: string
  onDrillErrorCode: (compoundKey: string) => void
  onOpenIssuesTable: () => void
  timeDays: number
  onTimeChange: (d: number) => void
  categoryOptions: CatOpt[]
  categoryValue: string
  onCategoryChange: (v: string) => void
  lastSyncLabel: string
  globalTimeLabel: string
  asOfActive: boolean
}

export function DashboardStoryView({
  issues,
  issuesLoading,
  statsTotalIssues,
  heroCategoryName,
  heroUrgencyLine,
  fingerprintSurges,
  windowLabel,
  onDrillErrorCode,
  onOpenIssuesTable,
  timeDays,
  onTimeChange,
  categoryOptions,
  categoryValue,
  onCategoryChange,
  lastSyncLabel,
  globalTimeLabel,
  asOfActive,
}: DashboardStoryViewProps) {
  const points = useMemo(() => buildStoryTimeline(issues), [issues])
  const topCats = useMemo(() => groupCategoriesByCount(points).slice(0, 4), [points])
  const surges = fingerprintSurges?.surges ?? []
  const newCodes = fingerprintSurges?.new_in_window ?? []

  return (
    <div className="max-w-3xl mx-auto space-y-16 pb-24">
      <header className="pt-2 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Story</p>
        <h2 className="text-3xl sm:text-4xl font-serif font-bold text-foreground text-balance leading-tight">
          How Codex feedback is clustering right now
        </h2>
        <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl">
          A read-only narrative built from the same data as the dashboard. Scroll to see how signals distribute in
          time, where complaints concentrate, and what error patterns are spiking.
        </p>
        <DataProvenanceStrip
          lastSyncLabel={lastSyncLabel}
          issueWindowLabel={globalTimeLabel}
          asOfActive={asOfActive}
        />
      </header>

      <section className="space-y-4 scroll-mt-8" id="story-filters">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Window</h3>
        <GlobalFilterBar
          timeDays={timeDays}
          onTimeChange={onTimeChange}
          categoryOptions={categoryOptions}
          categoryValue={categoryValue}
          onCategoryChange={onCategoryChange}
        />
        <p className="text-sm text-muted-foreground">
          {issuesLoading
            ? "Loading observations…"
            : `${issues.length} rows loaded for the chart (capped for performance; table may show more with paging).`}{" "}
          Total canonical signals in view: {statsTotalIssues}.
        </p>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2 text-primary">
          <BookOpen className="h-5 w-5" />
          <h3 className="text-2xl font-serif font-semibold">The lede</h3>
        </div>
        <p className="text-xl sm:text-2xl font-serif leading-relaxed text-foreground">
          {heroCategoryName
            ? `The loudest theme in the last 72 hours is ${heroCategoryName}. ${heroUrgencyLine ?? ""}`
            : "No single category is dominating the short window — scan the cloud below for where volume piles up."}
        </p>
      </section>

      <section className="space-y-6">
        <h3 className="text-2xl font-serif font-semibold">Signal cloud in time</h3>
        <p className="text-muted-foreground leading-relaxed">
          Public reports in your current filter, placed along a clock. Bigger circles carry higher impact scores; color
          follows heuristic category — the same cut as the rest of the app.
        </p>
        <Card className="border-border/60 bg-gradient-to-b from-card to-muted/20 overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <SignalTimelineStory points={points} timeLabel={globalTimeLabel} />
          </CardContent>
        </Card>
        {topCats.length > 0 && (
          <ul className="flex flex-wrap gap-3 text-sm">
            {topCats.map((c) => (
              <li
                key={c.name}
                className="inline-flex items-center gap-2 rounded-full border border-border/80 px-3 py-1.5"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.color }} />
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground">({c.count})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="h-5 w-5" />
          <h3 className="text-2xl font-serif font-semibold">Error-code gravity</h3>
        </div>
        <p className="text-muted-foreground leading-relaxed">
          Regex fingerprints (not the LLM layer) that are surging in <span className="whitespace-nowrap">{windowLabel}</span>.
          Drilling applies the same <code className="text-xs bg-muted px-1 rounded">compound_key</code> filter as the dashboard
          issues table.
        </p>
        {surges.length === 0 && newCodes.length === 0 ? (
          <p className="text-sm text-muted-foreground border border-dashed rounded-lg p-4">
            No surges in this window — healthy fingerprint landscape.
          </p>
        ) : (
          <ul className="space-y-2">
            {surges.slice(0, 6).map((s) => (
              <li key={s.error_code} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-2">
                <code className="text-sm font-mono text-foreground">{s.error_code}</code>
                <span className="text-xs text-muted-foreground">
                  {s.now_count} now vs {s.prev_count} prior · +{s.delta}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onDrillErrorCode(`err:${s.error_code}`)}
                >
                  Drill in
                </Button>
              </li>
            ))}
            {newCodes.slice(0, 4).map((n) => (
              <li key={n.error_code} className="text-xs text-muted-foreground">
                New this window: <code className="font-mono">{n.error_code}</code> ({n.count} reports) ·{" "}
                <button
                  type="button"
                  className="text-primary underline"
                  onClick={() => onDrillErrorCode(`err:${n.error_code}`)}
                >
                  open in table
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4 text-center" id="story-cta">
        <ArrowDown className="h-6 w-6 text-muted-foreground mx-auto" />
        <h3 className="text-xl font-serif font-semibold">What to do with this</h3>
        <p className="text-muted-foreground max-w-lg mx-auto">
          Use the dashboard for the full matrix and charts; the story tab is a guided read. The issues table is the
          source-of-truth list with links to original posts.
        </p>
        <Button type="button" size="lg" onClick={onOpenIssuesTable} className="gap-2">
          Open issues table
          <ExternalLink className="h-4 w-4" />
        </Button>
      </section>
    </div>
  )
}
