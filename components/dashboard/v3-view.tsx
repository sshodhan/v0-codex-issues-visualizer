"use client"

import Link from "next/link"
import { Sparkles } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ClusterRollupRow } from "@/hooks/use-dashboard-data"
import type { PipelineStateSummary } from "@/lib/classification/pipeline-state"

type RailKey = "fix_next" | "breaking_now" | "review_now"

const RAILS: Array<{
  key: RailKey
  title: string
  description: string
  score: (cluster: ClusterRollupRow) => number
  tag: "actionability" | "surge" | "review_pressure"
  metric: (cluster: ClusterRollupRow) => { value: string; caption: string }
}> = [
  {
    key: "fix_next",
    title: "Fix next",
    description: "Highest actionability and concentrated technical signal.",
    score: (cluster) => cluster.rail_scoring?.actionability_input ?? 0,
    tag: "actionability",
    metric: (cluster) => {
      const v = cluster.avg_impact ?? cluster.rail_scoring?.actionability_input ?? 0
      return { value: cluster.avg_impact != null ? String(v) : "—", caption: "avg impact" }
    },
  },
  {
    key: "breaking_now",
    title: "Breaking now",
    description: "Largest current-window surge by family volume.",
    score: (cluster) => cluster.rail_scoring?.surge_input ?? cluster.count,
    tag: "surge",
    metric: (cluster) => ({
      value: String(cluster.rail_scoring?.surge_input ?? cluster.count),
      caption: "in window",
    }),
  },
  {
    key: "review_now",
    title: "Review now",
    description: "Most immediate human-review pressure in triage.",
    score: (cluster) => cluster.rail_scoring?.review_pressure_input ?? Math.max(0, cluster.count - cluster.reviewed_count),
    tag: "review_pressure",
    metric: (cluster) => ({
      value: String(cluster.rail_scoring?.review_pressure_input ?? Math.max(0, cluster.count - cluster.reviewed_count)),
      caption: "unreviewed",
    }),
  },
]

function getFamilyLabel(cluster: ClusterRollupRow) {
  if (cluster.label && cluster.label_confidence != null && cluster.label_confidence >= 0.6) return cluster.label
  return cluster.representative_title || "Unlabelled family"
}

function getTopClusters(clusters: ClusterRollupRow[], railTag: "actionability" | "surge" | "review_pressure", score: (cluster: ClusterRollupRow) => number) {
  const tagged = clusters.filter((cluster) => cluster.rail_scoring?.rail_tags?.includes(railTag))
  const candidatePool = tagged.length > 0 ? tagged : clusters
  return [...candidatePool]
    .sort((a, b) => {
      const delta = score(b) - score(a)
      if (delta !== 0) return delta
      return b.count - a.count
    })
    .slice(0, 3)
}

function TrustBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  const color = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-400" : "bg-red-400"
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function OriginChip({ path }: { path: "semantic" | "fallback" }) {
  if (path === "semantic") {
    return <Badge variant="outline" className="border-teal-500/40 text-teal-600 text-[10px] font-medium px-1.5 py-0">SEMANTIC</Badge>
  }
  return <Badge variant="outline" className="text-[10px] font-medium px-1.5 py-0 text-muted-foreground">TITLE FALLBACK</Badge>
}

function StateChips({ cluster }: { cluster: ClusterRollupRow }) {
  const tags = cluster.rail_scoring?.rail_tags ?? []
  const chips: Array<{ label: string; className: string }> = []
  if (tags.includes("surge")) chips.push({ label: "SURGE", className: "border-amber-500/40 text-amber-600 text-[10px] font-medium px-1.5 py-0" })
  if (tags.includes("review_pressure")) chips.push({ label: "NEEDS REVIEW", className: "border-red-400/40 text-red-500 text-[10px] font-medium px-1.5 py-0" })
  if (tags.includes("actionability") && (cluster.rail_scoring?.actionability_input ?? 0) >= 0.7) {
    chips.push({ label: "HIGH SIGNAL", className: "border-violet-500/40 text-violet-600 text-[10px] font-medium px-1.5 py-0" })
  }
  if (chips.length === 0) return null
  return (
    <>
      {chips.map((c) => (
        <Badge key={c.label} variant="outline" className={c.className}>{c.label}</Badge>
      ))}
    </>
  )
}

function RegexVariantsStrip({ variants }: { variants: ClusterRollupRow["regex_variants"] }) {
  if (!variants || variants.length === 0) return <p className="text-[11px] text-muted-foreground">No fingerprint signal extracted.</p>
  const kindLabel: Record<string, string> = { err: "err", stack: "stack", env: "env", sdk: "sdk" }
  return (
    <div className="flex flex-wrap gap-1">
      {variants.map((v, i) => (
        <Badge key={i} variant="secondary" className="font-mono text-[10px] gap-0.5 px-1.5">
          <span className="text-muted-foreground">{kindLabel[v.kind]}:</span>
          <span className="truncate max-w-[120px]">{v.value}</span>
        </Badge>
      ))}
    </div>
  )
}

function BreadthMatrix({ breadth }: { breadth: ClusterRollupRow["breadth"] }) {
  if (!breadth) return null
  const sourceEntries = Object.entries(breadth.sources).sort((a, b) => b[1] - a[1])
  return (
    <div className="flex flex-wrap gap-1">
      {sourceEntries.map(([src, count]) => (
        <Badge key={src} variant="outline" className="text-[10px] px-1.5">
          {src} ({count})
        </Badge>
      ))}
      {breadth.os.map((os) => (
        <Badge key={os} variant="outline" className="text-[10px] px-1.5 text-muted-foreground">{os}</Badge>
      ))}
    </div>
  )
}

function ClusterCard({
  cluster,
  idx,
  metric,
  days,
}: {
  cluster: ClusterRollupRow
  idx: number
  metric: { value: string; caption: string }
  days: number
}) {
  const classified = cluster.classified_share ?? (cluster.count > 0 ? cluster.classified_count / cluster.count : 0)
  const reviewed = cluster.human_reviewed_share ?? (cluster.count > 0 ? cluster.reviewed_count / cluster.count : 0)
  const regexCoverage = cluster.fingerprint_hit_rate

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold line-clamp-2">{idx + 1}. {getFamilyLabel(cluster)}</p>
          <div className="flex flex-wrap items-center gap-1">
            <OriginChip path={cluster.cluster_path} />
            <StateChips cluster={cluster} />
          </div>
        </div>
        <div className="flex flex-col items-end shrink-0 text-right">
          <span className="text-lg font-bold tabular-nums leading-none">{metric.value}</span>
          <span className="text-[10px] text-muted-foreground leading-tight">{metric.caption}</span>
        </div>
      </div>

      {/* Why surfaced */}
      {cluster.why_surfaced ? (
        <p className="flex items-start gap-1 text-xs text-muted-foreground">
          <Sparkles className="size-3 mt-0.5 shrink-0" />
          {cluster.why_surfaced}
        </p>
      ) : null}

      {/* Three-panel body */}
      <div className="border-t pt-2 space-y-3">
        {/* Panel 1: Trust & Completeness */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Trust & Completeness</p>
          <TrustBar label="Classified" value={classified} />
          <TrustBar label="Human reviewed" value={reviewed} />
          <TrustBar label="Regex coverage" value={regexCoverage} />
        </div>

        {/* Panel 2: Regex Variants */}
        {cluster.regex_variants !== undefined ? (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Regex Variants</p>
            <RegexVariantsStrip variants={cluster.regex_variants} />
          </div>
        ) : null}

        {/* Panel 3: Breadth */}
        {cluster.breadth && Object.keys(cluster.breadth.sources).length > 0 ? (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sources & Env</p>
            <BreadthMatrix breadth={cluster.breadth} />
          </div>
        ) : null}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-1.5">
        <Button asChild size="sm" variant="outline">
          <Link href={`/families/${cluster.id}?days=${days}`}>Open family</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href={`/?tab=classifications&cluster=${cluster.id}&ux=v3`}>Review triage</Link>
        </Button>
        {cluster.representative_observation_id ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/observations/${cluster.representative_observation_id}/trace`}>View trace</Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function RailEmptyState({
  railKey,
  pipelineState,
  days,
}: {
  railKey: RailKey
  pipelineState: PipelineStateSummary | null | undefined
  days: number
}) {
  if (!pipelineState) {
    return <p className="text-sm text-muted-foreground">Loading pipeline state…</p>
  }

  if (pipelineState.data_state === "degraded") {
    const { degraded_reason } = pipelineState
    if (degraded_reason === "source_query_failed") {
      return (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>Data source failed to respond — cluster rankings may be stale.</p>
          <Link href="/admin" className="text-xs text-primary hover:underline">Open admin panel</Link>
        </div>
      )
    }
    if (degraded_reason === "openai_unconfigured") {
      return (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>LLM classification is unavailable (OPENAI_API_KEY not configured). Clusters may be unclassified.</p>
          <Link href="/admin" className="text-xs text-primary hover:underline">Open admin panel</Link>
        </div>
      )
    }
    if (degraded_reason === "classify_backfill_failed") {
      return (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>Classify backfill failed — rankings may be outdated.</p>
          <Link href="/admin?tab=classify-backfill" className="text-xs text-primary hover:underline">Re-run classify backfill</Link>
        </div>
      )
    }
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>Pipeline error detected.</p>
        <Link href="/admin" className="text-xs text-primary hover:underline">Open admin panel</Link>
      </div>
    )
  }

  if (pipelineState.data_state === "empty_healthy") {
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>No observations in the current {days}-day window.</p>
        <span className="text-xs">Try widening the time range using the days filter.</span>
      </div>
    )
  }

  // healthy or pending_classification — rail is genuinely quiet
  const { observations_in_window, clustered_count } = pipelineState
  if (railKey === "fix_next") {
    return (
      <p className="text-sm text-muted-foreground">
        No clusters with concentrated error signal in this window ({observations_in_window} observations, {clustered_count} clustered).
      </p>
    )
  }
  if (railKey === "breaking_now") {
    return (
      <p className="text-sm text-muted-foreground">
        No surge detected — activity is within normal range for this window.
      </p>
    )
  }
  return (
    <p className="text-sm text-muted-foreground">
      All clusters reviewed — triage is clear for this window.
    </p>
  )
}

export function V3View({
  clusters,
  days,
  pipelineState,
}: {
  clusters: ClusterRollupRow[]
  days: number
  pipelineState?: PipelineStateSummary | null
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-xl font-semibold">Prioritized rails</h3>
        <p className="text-sm text-muted-foreground">Three ranking rails generated from cluster rollup scoring and surfaced rationale.</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {RAILS.map((rail) => {
          const topClusters = getTopClusters(clusters, rail.tag, rail.score)
          return (
            <Card key={rail.key}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{rail.title}</CardTitle>
                <p className="text-xs text-muted-foreground">{rail.description}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                {topClusters.length === 0 ? (
                  <RailEmptyState railKey={rail.key} pipelineState={pipelineState} days={days} />
                ) : (
                  topClusters.map((cluster, idx) => (
                    <ClusterCard
                      key={cluster.id}
                      cluster={cluster}
                      idx={idx}
                      metric={rail.metric(cluster)}
                      days={days}
                    />
                  ))
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </section>
  )
}
