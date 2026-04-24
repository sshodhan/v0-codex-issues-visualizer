"use client"

import Link from "next/link"
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
}> = [
  {
    key: "fix_next",
    title: "Fix next",
    description: "Highest actionability and concentrated technical signal.",
    score: (cluster) => cluster.rail_scoring?.actionability_input ?? 0,
    tag: "actionability",
  },
  {
    key: "breaking_now",
    title: "Breaking now",
    description: "Largest current-window surge by family volume.",
    score: (cluster) => cluster.rail_scoring?.surge_input ?? cluster.count,
    tag: "surge",
  },
  {
    key: "review_now",
    title: "Review now",
    description: "Most immediate human-review pressure in triage.",
    score: (cluster) => cluster.rail_scoring?.review_pressure_input ?? Math.max(0, cluster.count - cluster.reviewed_count),
    tag: "review_pressure",
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
                  topClusters.map((cluster, idx) => {
                    const scoreValue = rail.score(cluster)
                    return (
                      <div key={cluster.id} className="rounded-md border border-border p-3 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium line-clamp-2">{idx + 1}. {getFamilyLabel(cluster)}</p>
                          <Badge variant="secondary" className="shrink-0">{scoreValue.toFixed(2)}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{cluster.why_surfaced || "representative semantic cluster"}</p>
                        <p className="text-xs text-muted-foreground">{cluster.count} observations · {cluster.reviewed_count} reviewed</p>
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/families/${cluster.id}?days=${days}`}>Open family</Link>
                          </Button>
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/?tab=classifications&cluster=${cluster.id}&ux=v3`}>Review triage</Link>
                          </Button>
                          {cluster.representative_observation_id ? (
                            <Button asChild size="sm" variant="ghost">
                              <Link href={`/observations/${cluster.representative_observation_id}/trace`}>
                                View trace
                              </Link>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    )
                  })
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </section>
  )
}
