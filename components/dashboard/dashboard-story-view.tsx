"use client"

import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { SignalTimelineStory } from "@/components/dashboard/signal-timeline-story"
import { buildStoryTimeline, groupCategoriesByCount } from "@/lib/dashboard/story-timeline"
import type { ClusterRollupRow, FingerprintSurgeResponse, Issue } from "@/hooks/use-dashboard-data"
import { MIN_DISPLAYABLE_LABEL_CONFIDENCE } from "@/lib/storage/cluster-label-fallback"
import {
  ArrowDown,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ExternalLink,
  Layers3,
  TriangleAlert,
} from "lucide-react"
import { StoryCategoryAtlas } from "@/components/dashboard/story-category-atlas"
import { GlobalFilterBar } from "@/components/dashboard/global-filter-bar"
import { DataProvenanceStrip } from "@/components/dashboard/data-provenance-strip"

type CatOpt = { value: string; label: string; count: number }

const SEVERITY_DOT: Record<
  NonNullable<ClusterRollupRow["dominant_severity"]>,
  { className: string; label: string }
> = {
  low: { className: "bg-muted-foreground/40", label: "Low severity" },
  medium: { className: "bg-amber-500", label: "Medium severity" },
  high: { className: "bg-orange-500", label: "High severity" },
  critical: { className: "bg-red-600", label: "Critical severity" },
}

function SeverityDot({
  level,
}: {
  level: NonNullable<ClusterRollupRow["dominant_severity"]>
}) {
  const dot = SEVERITY_DOT[level]
  return (
    <span
      aria-label={dot.label}
      title={dot.label}
      className={`inline-block h-2 w-2 rounded-full ${dot.className}`}
    />
  )
}

function SurgeDelta({ pct }: { pct: number }) {
  if (Math.abs(pct) < 5) return null
  const up = pct > 0
  const sign = up ? "+" : "−"
  return (
    <span
      title={up ? "More than the prior window" : "Fewer than the prior window"}
      className={up ? "text-foreground" : "text-muted-foreground"}
    >
      {up ? "↑" : "↓"} {sign}
      {Math.abs(Math.round(pct))}% vs prior
    </span>
  )
}

function clusterPrimaryTitle(r: ClusterRollupRow): {
  title: string
  source: "representative" | "label" | "fallback"
} {
  const rep = r.representative_title?.trim()
  if (rep) return { title: rep, source: "representative" }
  if (
    r.label &&
    r.label_confidence != null &&
    r.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE
  ) {
    return { title: r.label, source: "label" }
  }
  return { title: "Untitled cluster", source: "fallback" }
}

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
  clusterRows?: ClusterRollupRow[] | undefined
  onOpenClusterInTable: (clusterId: string) => void
  onOpenClusterInTriage: (clusterId: string) => void
  activeClusterId: string | null
  timeDays: number
  onTimeChange: (d: number) => void
  categoryOptions: CatOpt[]
  categoryValue: string
  onCategoryChange: (v: string) => void
  lastSyncLabel: string
  globalTimeLabel: string
  asOfActive: boolean
  /** Heuristic + LLM category breakdowns from /api/stats (same window as dashboard) */
  categoryBreakdown: Array<{ name: string; count: number; color: string }>
  llmCategoryBreakdown: Array<{ name: string; count: number }>
  llmClassifiedInWindow: number
  llmPendingInWindow: number
  onStoryHeuristicFromAtlas: (slug: string) => void
  onStoryLlmTriage: (llmCategorySlug: string) => void
  onOpenDashboardFromAtlas: () => void
  selectedLlmCategorySlug: string | null
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
  clusterRows,
  onOpenClusterInTable,
  onOpenClusterInTriage,
  activeClusterId,
  timeDays,
  onTimeChange,
  categoryOptions,
  categoryValue,
  onCategoryChange,
  lastSyncLabel,
  globalTimeLabel,
  asOfActive,
  categoryBreakdown,
  llmCategoryBreakdown,
  llmClassifiedInWindow,
  llmPendingInWindow,
  onStoryHeuristicFromAtlas,
  onStoryLlmTriage,
  onOpenDashboardFromAtlas,
  selectedLlmCategorySlug,
}: DashboardStoryViewProps) {
  const points = useMemo(() => buildStoryTimeline(issues), [issues])
  const topCats = useMemo(() => groupCategoriesByCount(points).slice(0, 4), [points])
  const surges = fingerprintSurges?.surges ?? []
  const newCodes = fingerprintSurges?.new_in_window ?? []
  const showClusterSection = (clusterRows?.length ?? 0) > 0

  const { multiClusters, singletonClusters } = useMemo(() => {
    const rows = clusterRows ?? []
    return {
      multiClusters: rows.filter((r) => r.count > 1),
      singletonClusters: rows.filter((r) => r.count === 1),
    }
  }, [clusterRows])

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

      <StoryCategoryAtlas
        globalTimeLabel={globalTimeLabel}
        globalCategoryLabel={
          categoryOptions.find((o) => o.value === categoryValue)?.label ?? "All topics"
        }
        totalIssues={statsTotalIssues}
        heuristicRows={categoryBreakdown}
        llmRows={llmCategoryBreakdown}
        llmClassifiedInWindow={llmClassifiedInWindow}
        llmPendingInWindow={llmPendingInWindow}
        onSelectHeuristicSlug={onStoryHeuristicFromAtlas}
        onOpenLlmInTriage={onStoryLlmTriage}
        onOpenDashboard={onOpenDashboardFromAtlas}
        selectedHeuristicSlug={categoryValue}
        selectedLlmCategorySlug={selectedLlmCategorySlug}
      />

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

      {showClusterSection && (
        <section className="space-y-4">
          <div className="flex items-center gap-2 text-primary">
            <Layers3 className="h-5 w-5" />
            <h3 className="text-2xl font-serif font-semibold">Where reports cluster</h3>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            Reports that look alike, grouped by their text content. The biggest groups are the
            most repeated complaints — open one to read the raw posts, or jump to triage to see
            how the classifier labelled each item.
          </p>

          {multiClusters.length > 0 ? (
            <ul className="divide-y divide-border/50">
              {multiClusters.slice(0, 8).map((r) => (
                <ClusterStoryRow
                  key={r.id}
                  cluster={r}
                  isActive={activeClusterId === r.id}
                  onExplore={() => onOpenClusterInTable(r.id)}
                  onTriage={() => onOpenClusterInTriage(r.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm italic text-muted-foreground border border-dashed rounded-lg p-4">
              No multi-report families in this window — every signal so far stands alone.
            </p>
          )}

          {singletonClusters.length > 0 && (
            <Collapsible className="rounded-lg border border-border/50 bg-card/40">
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded-lg">
                <span>
                  Show {singletonClusters.length} single-report cluster
                  {singletonClusters.length === 1 ? "" : "s"}
                </span>
                <ChevronDown className="h-4 w-4 transition-transform data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="divide-y divide-border/40 px-4 pb-2">
                  {singletonClusters.slice(0, 20).map((r) => (
                    <ClusterStoryRow
                      key={r.id}
                      cluster={r}
                      isActive={activeClusterId === r.id}
                      onExplore={() => onOpenClusterInTable(r.id)}
                      onTriage={() => onOpenClusterInTriage(r.id)}
                      compact
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </section>
      )}

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

function ClusterStoryRow({
  cluster: r,
  isActive,
  onExplore,
  onTriage,
  compact = false,
}: {
  cluster: ClusterRollupRow
  isActive: boolean
  onExplore: () => void
  onTriage: () => void
  compact?: boolean
}) {
  const { title, source } = clusterPrimaryTitle(r)
  const reportsLabel = r.count === 1 ? "1 report" : `${r.count} reports`
  const showReviewed = r.classified_count > 0
  const showFingerprint = r.fingerprint_hit_rate > 0
  const showSurge =
    r.surge_delta_pct != null && Number.isFinite(r.surge_delta_pct) && r.surge_delta_pct !== 0

  return (
    <li
      className={`${compact ? "py-2.5" : "py-4"} ${
        isActive ? "bg-muted/30 -mx-2 px-2 rounded-md" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h4
            className={`${
              compact ? "text-sm" : "text-base"
            } font-medium text-foreground leading-snug line-clamp-2`}
            title={source === "fallback" ? `Cluster ${r.id.slice(0, 8)}` : title}
          >
            {title}
          </h4>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
            {r.dominant_severity && <SeverityDot level={r.dominant_severity} />}
            <span className="font-medium text-foreground/80">{reportsLabel}</span>
            {showReviewed && (
              <span>
                {r.reviewed_count}/{r.classified_count} reviewed
              </span>
            )}
            {showFingerprint && (
              <span title="Share of reports that match a known regex fingerprint">
                {Math.round(r.fingerprint_hit_rate * 100)}% fingerprinted
              </span>
            )}
            {showSurge && <SurgeDelta pct={r.surge_delta_pct as number} />}
          </div>
          <p className="font-mono text-[10px] tracking-tight text-muted-foreground/70">
            cluster {r.id.slice(0, 8)}
            {r.cluster_path === "fallback" ? " · title fallback" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={onTriage}
          >
            Triage
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1 px-2.5 text-xs"
            onClick={onExplore}
          >
            Explore
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </li>
  )
}
