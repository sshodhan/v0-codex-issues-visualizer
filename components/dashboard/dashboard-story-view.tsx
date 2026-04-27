"use client"

import { useMemo, useState } from "react"
import { format } from "date-fns"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SignalTimelineStory,
  type TimelineAnnotation,
  type TimelineHighlight,
} from "@/components/dashboard/signal-timeline-story"
import { buildStoryTimeline, groupCategoriesByCount } from "@/lib/dashboard/story-timeline"
import { computeStoryLede } from "@/lib/dashboard/story-lede"
import type { ClusterRollupRow, FingerprintSurgeResponse, Issue } from "@/hooks/use-dashboard-data"
import { MIN_DISPLAYABLE_LABEL_CONFIDENCE } from "@/lib/storage/cluster-label-fallback"
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ExternalLink,
  Layers3,
  TriangleAlert,
} from "lucide-react"
import { StoryCategoryAtlas } from "@/components/dashboard/story-category-atlas"
import { GlobalFilterBar } from "@/components/dashboard/global-filter-bar"
import { DataProvenanceStrip } from "@/components/dashboard/data-provenance-strip"
import { StoryDrawer } from "@/components/dashboard/story-drawer"
import type { StoryDrawerTarget } from "@/components/dashboard/story-drawer/types"
import { useDrawerHash } from "@/components/dashboard/story-drawer/use-drawer-hash"
import { StickyScopeBar } from "@/components/dashboard/sticky-scope-bar"

type CatOpt = { value: string; label: string; count: number }

/**
 * Severity badge encoding: dot color + single-letter code so the level survives
 * for color-vision-deficient readers and grayscale prints.
 */
const SEVERITY_BADGE: Record<
  NonNullable<ClusterRollupRow["dominant_severity"]>,
  { dot: string; code: "L" | "M" | "H" | "C"; label: string }
> = {
  low: { dot: "bg-muted-foreground/40", code: "L", label: "Low severity" },
  medium: { dot: "bg-amber-500", code: "M", label: "Medium severity" },
  high: { dot: "bg-orange-500", code: "H", label: "High severity" },
  critical: { dot: "bg-red-600", code: "C", label: "Critical severity" },
}

function SeverityBadge({
  level,
}: {
  level: NonNullable<ClusterRollupRow["dominant_severity"]>
}) {
  const b = SEVERITY_BADGE[level]
  return (
    <span
      aria-label={b.label}
      title={b.label}
      className="inline-flex items-center gap-1"
    >
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${b.dot}`} />
      <span aria-hidden className="font-mono text-[10px] font-semibold tracking-wider">
        {b.code}
      </span>
    </span>
  )
}

/** Format a window of N hours into a short, readable suffix (e.g., "24h", "7d", "2w"). */
function formatWindowHours(hours: number | undefined): string {
  if (!hours || hours <= 0) return "prior"
  if (hours < 24) return `prior ${Math.round(hours)}h`
  const days = hours / 24
  if (days < 7) return `prior ${Math.round(days)}d`
  const weeks = days / 7
  if (weeks < 4.5) return `prior ${Math.round(weeks)}w`
  return `prior ${Math.round(days / 30)}mo`
}

function SurgeDelta({ pct, windowHours }: { pct: number; windowHours?: number }) {
  if (Math.abs(pct) < 5) return null
  const up = pct > 0
  const sign = up ? "+" : "−"
  const window = formatWindowHours(windowHours)
  return (
    <span
      title={up ? `More than the ${window}` : `Fewer than the ${window}`}
      className={up ? "text-foreground" : "text-muted-foreground"}
    >
      {up ? "↑" : "↓"} {sign}
      {Math.abs(Math.round(pct))}% vs {window}
    </span>
  )
}

/**
 * Editorial eyebrow shown above each section's H3 — turns "The lede" into
 * "02 — The lede". Numbers are deliberately quiet (muted) so they read as
 * scaffolding, not decoration.
 */
function SectionEyebrow({ index, label }: { index: string; label: string }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-widest text-primary">
      <span className="text-muted-foreground">{index}</span>
      <span aria-hidden className="mx-2 text-muted-foreground/60">
        —
      </span>
      {label}
    </p>
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

  // Drawer state — single source of truth for "what is the user exploring."
  const [drawerTarget, setDrawerTarget] = useState<StoryDrawerTarget>(null)
  useDrawerHash(drawerTarget, setDrawerTarget)

  // Time extent of the loaded sample. One computation that feeds both the
  // drawer sparklines and the editorial lede.
  const windowMs = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    for (const p of points) {
      const t = new Date(p.publishedAt).getTime()
      if (Number.isNaN(t)) continue
      if (t < min) min = t
      if (t > max) max = t
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      const now = Date.now()
      return { startMs: now - timeDays * 86_400_000, endMs: now }
    }
    return { startMs: min, endMs: max }
  }, [points, timeDays])

  // Translate drawer state → timeline highlight (drives cross-filter dim).
  const timelineHighlight = useMemo<TimelineHighlight>(() => {
    if (!drawerTarget) return null
    if (drawerTarget.kind === "heuristic")
      return { kind: "heuristic", slug: drawerTarget.slug }
    if (drawerTarget.kind === "cluster")
      return { kind: "cluster", clusterId: drawerTarget.clusterId }
    if (drawerTarget.kind === "issue")
      return { kind: "issue", issueId: drawerTarget.issueId }
    return null
  }, [drawerTarget])

  // Editorial lede: pick the most newsworthy framing of the window (peak day /
  // surge / quiet / empty) and produce a one-or-two-sentence headline. The
  // peak-day fraction drives the chart annotation band.
  const lede = useMemo(() => computeStoryLede(points, windowMs), [points, windowMs])

  const timelineAnnotation = useMemo<TimelineAnnotation | null>(() => {
    if (!lede.peakDayMs || lede.peakDayFrac == null || !lede.peakCount) return null
    // Don't annotate when the "peak" carries no real information
    // (e.g. a single quiet day with one report).
    if (lede.kind === "empty") return null
    if (lede.kind === "quiet" && lede.peakCount < 2) return null
    return {
      peakDayFrac: lede.peakDayFrac,
      peakLabel: `${format(new Date(lede.peakDayMs), "MMM d")} — ${lede.peakCount} ${
        lede.peakCount === 1 ? "report" : "reports"
      }`,
    }
  }, [lede])

  return (
    <div className="max-w-3xl mx-auto space-y-16 pb-24">
      <StickyScopeBar
        globalTimeLabel={globalTimeLabel}
        categoryLabel={
          categoryOptions.find((o) => o.value === categoryValue)?.label ?? "All topics"
        }
        totalCount={statsTotalIssues}
        asOfActive={asOfActive}
        onClearCategory={
          categoryValue === "all" ? undefined : () => onCategoryChange("all")
        }
        onOpenDashboard={onOpenDashboardFromAtlas}
      />
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
        onExploreBubble={(t) => setDrawerTarget(t)}
        selectedHeuristicSlug={categoryValue}
        selectedLlmCategorySlug={selectedLlmCategorySlug}
        exploringTarget={
          drawerTarget?.kind === "heuristic" || drawerTarget?.kind === "llm"
            ? {
                kind: drawerTarget.kind,
                slug: drawerTarget.slug,
                label: drawerTarget.label,
              }
            : null
        }
        onClearExploring={() => setDrawerTarget(null)}
      />

      <section className="space-y-3">
        <SectionEyebrow index="02" label="The lede" />
        <div className="flex items-center gap-2 text-primary">
          <BookOpen className="h-5 w-5" />
          <h3 className="text-2xl font-serif font-semibold">The lede</h3>
        </div>
        <p className="text-xl sm:text-2xl font-serif leading-relaxed text-foreground text-balance first-letter:float-left first-letter:mr-2 first-letter:mt-1 first-letter:text-5xl first-letter:font-bold first-letter:leading-[0.85]">
          {lede.headline}
        </p>
        {lede.subhead && (
          <p className="text-base text-muted-foreground leading-relaxed">{lede.subhead}</p>
        )}
      </section>

      <section className="space-y-4">
        <SectionEyebrow index="03" label="Signals over time" />
        <h3 className="text-2xl font-serif font-semibold">Signal cloud in time</h3>
        <p className="text-muted-foreground leading-relaxed">
          Public reports in your current filter, placed along a clock. Bigger circles carry higher impact scores; color
          follows heuristic category — the same cut as the rest of the app.
        </p>
        <Card className="border-border/60 bg-gradient-to-b from-card to-muted/20 overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <SignalTimelineStory
              points={points}
              timeLabel={globalTimeLabel}
              highlight={timelineHighlight}
              annotation={timelineAnnotation}
              onSelectIssue={(id) => setDrawerTarget({ kind: "issue", issueId: id })}
            />
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
          <SectionEyebrow index="04" label="Where reports cluster" />
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
                  isActive={
                    activeClusterId === r.id ||
                    (drawerTarget?.kind === "cluster" && drawerTarget.clusterId === r.id)
                  }
                  onExplore={() => setDrawerTarget({ kind: "cluster", clusterId: r.id })}
                  onTriage={() => onOpenClusterInTriage(r.id)}
                />
              ))}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-border/70 p-4 space-y-3">
              <p className="text-sm italic text-muted-foreground">
                No multi-report families in this window — every signal so far stands alone.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() =>
                  document
                    .getElementById("story-filters")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                Widen the window
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {singletonClusters.length > 0 && (
            <Collapsible className="rounded-lg border border-border/50 bg-card/40">
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/30 rounded-lg">
                <div className="flex flex-col items-start gap-0.5">
                  <span className="text-sm text-muted-foreground hover:text-foreground">
                    Show {singletonClusters.length} single-report cluster
                    {singletonClusters.length === 1 ? "" : "s"}
                  </span>
                  <span className="text-xs text-muted-foreground/70">
                    Reports we couldn&rsquo;t group with anything else yet — collapsed to keep the
                    main list focused on repeated complaints.
                  </span>
                </div>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="divide-y divide-border/40 px-4 pb-2">
                  {singletonClusters.slice(0, 20).map((r) => (
                    <ClusterStoryRow
                      key={r.id}
                      cluster={r}
                      isActive={
                        activeClusterId === r.id ||
                        (drawerTarget?.kind === "cluster" && drawerTarget.clusterId === r.id)
                      }
                      onExplore={() => setDrawerTarget({ kind: "cluster", clusterId: r.id })}
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
        <SectionEyebrow index="05" label="What's breaking" />
        <div className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="h-5 w-5" />
          <h3 className="text-2xl font-serif font-semibold">Error-code gravity</h3>
        </div>
        <p className="text-muted-foreground leading-relaxed">
          Specific error patterns rising in <span className="whitespace-nowrap">{windowLabel}</span>.
          Click <em>Drill in</em> on any code to see the underlying reports.
        </p>
        {surges.length === 0 && newCodes.length === 0 ? (
          <p className="text-sm text-muted-foreground border border-dashed rounded-lg p-4">
            No surges in this window — no rising error patterns.
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

      <Collapsible className="rounded-lg border border-border/50 bg-card/40">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg px-4 py-3 text-left hover:bg-muted/30">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            About these charts
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 px-4 pb-4 text-sm text-muted-foreground leading-relaxed">
          <p>
            <span className="font-medium text-foreground">Two views of the same window.</span>{" "}
            The atlas at the top shows two passes over the data. The first uses fast,
            keyword-based topics (the colors used everywhere else in the app). The second uses
            the structured classifier&rsquo;s own categories — a separate enum applied only after
            classification has run.
          </p>
          <p>
            <span className="font-medium text-foreground">Counts vs the classifier.</span> The
            classifier view only counts reports it has labelled — pending rows are called out as
            a number, never imputed. The page&rsquo;s overall total may exceed the classifier
            count when a backlog is processing.
          </p>
          <p>
            <span className="font-medium text-foreground">Cluster grouping.</span> A cluster is
            a set of reports the embedding model groups by similar text. Clusters tagged{" "}
            <em>grouped by title only</em> use a simpler title-match fallback when the embedding
            pass hasn&rsquo;t covered them yet — that&rsquo;s why a few clusters carry a
            single report.
          </p>
          <p>
            <span className="font-medium text-foreground">Lede framing.</span> The opening
            sentence picks the most newsworthy frame from the loaded sample (peak day, surge,
            or a quiet window) and writes one or two sentences in editorial voice. It never
            invents — empty windows say so.
          </p>
        </CollapsibleContent>
      </Collapsible>

      <StoryDrawer
        target={drawerTarget}
        onClose={() => setDrawerTarget(null)}
        onChangeTarget={setDrawerTarget}
        issues={issues}
        clusterRows={clusterRows}
        windowMs={windowMs}
        selectedHeuristicSlug={categoryValue}
        selectedLlmCategorySlug={selectedLlmCategorySlug}
        onSelectHeuristicSlug={onStoryHeuristicFromAtlas}
        onOpenLlmInTriage={onStoryLlmTriage}
        onOpenIssuesTable={onOpenIssuesTable}
        onOpenClusterInTable={onOpenClusterInTable}
        onOpenClusterInTriage={onOpenClusterInTriage}
        onDrillErrorCode={onDrillErrorCode}
      />
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
            {r.dominant_severity && <SeverityBadge level={r.dominant_severity} />}
            <span className="font-medium text-foreground/80">{reportsLabel}</span>
            {showReviewed && (
              <span>
                {r.reviewed_count}/{r.classified_count} reviewed
              </span>
            )}
            {showFingerprint && (
              <span>
                {Math.round(r.fingerprint_hit_rate * 100)}% match a known error pattern
              </span>
            )}
            {showSurge && (
              <SurgeDelta
                pct={r.surge_delta_pct as number}
                windowHours={r.surge_window_hours}
              />
            )}
          </div>
          <p className="font-mono text-[10px] tracking-tight text-muted-foreground/70">
            cluster {r.id.slice(0, 8)}
            {r.cluster_path === "fallback" ? " · grouped by title only" : ""}
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
