"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ClusterRollupRow } from "@/hooks/use-dashboard-data"

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

export function V3View({ clusters, days }: { clusters: ClusterRollupRow[]; days: number }) {
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
                  <p className="text-sm text-muted-foreground">No clusters available in this window.</p>
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
