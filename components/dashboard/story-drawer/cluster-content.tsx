"use client"

import { useMemo } from "react"
import { useIssues, type ClusterRollupRow } from "@/hooks/use-dashboard-data"
import { Button } from "@/components/ui/button"
import { ArrowRight, Brain } from "lucide-react"
import { DrawerSection } from "./section"
import { DistributionBar } from "./distribution-bar"
import { IssueList } from "./issue-list"
import { topByImpact } from "@/lib/dashboard/story-drawer-data"

const SEVERITY_SEGMENTS = [
  { key: "low", label: "Low", className: "bg-muted-foreground/40" },
  { key: "medium", label: "Medium", className: "bg-amber-500" },
  { key: "high", label: "High", className: "bg-orange-500" },
  { key: "critical", label: "Critical", className: "bg-red-600" },
]

const SENTIMENT_SEGMENTS = [
  { key: "positive", label: "Positive", className: "bg-emerald-500" },
  { key: "neutral", label: "Neutral", className: "bg-muted-foreground/40" },
  { key: "negative", label: "Negative", className: "bg-red-500" },
]

interface Props {
  cluster: ClusterRollupRow | null
  clusterId: string
  onOpenInTable: () => void
  onOpenInTriage: () => void
  onSelectIssue: (issueId: string) => void
}

/**
 * Cluster detail drawer. Pulls representative issues from the existing /api/issues
 * endpoint via SWR (cached, deduped) so the same fetch isn't repeated when reopening.
 */
export function ClusterDrawerContent({
  cluster,
  clusterId,
  onOpenInTable,
  onOpenInTriage,
  onSelectIssue,
}: Props) {
  const { issues: clusterIssues, isLoading } = useIssues({
    cluster_id: clusterId,
    sortBy: "impact_score",
    order: "desc",
  })
  const top = useMemo(() => topByImpact(clusterIssues, 5), [clusterIssues])

  if (!cluster) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm italic text-muted-foreground">
          {isLoading ? "Loading cluster…" : "Cluster not found in current window."}
        </p>
      </div>
    )
  }

  const sevDist = cluster.severity_distribution
  const sevTotal = sevDist
    ? sevDist.low + sevDist.medium + sevDist.high + sevDist.critical
    : 0
  const senDist = cluster.sentiment_distribution
  const senTotal = senDist ? senDist.positive + senDist.neutral + senDist.negative : 0

  const recent = cluster.recent_window_count ?? null
  const prior = cluster.prior_window_count ?? null
  const surge = cluster.surge_delta_pct
  const surgeDirection =
    surge != null && Number.isFinite(surge) && Math.abs(surge) >= 5
      ? surge > 0
        ? "up"
        : "down"
      : null

  const title =
    cluster.representative_title?.trim() || cluster.label?.trim() || "Untitled cluster"

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-1.5 px-4 pt-4 pb-3 border-b border-border/50">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Cluster
        </p>
        <h3 className="font-serif text-2xl font-semibold leading-tight text-foreground text-balance line-clamp-3">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground tabular-nums">
          {cluster.count} {cluster.count === 1 ? "report" : "reports"} ·{" "}
          {cluster.classified_count} classified · {cluster.reviewed_count} reviewed
        </p>
        <p className="font-mono text-[10px] tracking-tight text-muted-foreground/70">
          cluster {cluster.id.slice(0, 8)}
          {cluster.cluster_path === "fallback" ? " · title fallback" : ""}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {(recent != null || prior != null) && (
          <DrawerSection
            title="Trend"
            caption={
              cluster.surge_window_hours
                ? `${cluster.surge_window_hours}h windows`
                : undefined
            }
          >
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-border/60 bg-card p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Recent
                </p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums">{recent ?? "—"}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-card p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Prior
                </p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-muted-foreground">
                  {prior ?? "—"}
                </p>
              </div>
            </div>
            {surgeDirection && (
              <p
                className={`mt-2 text-sm tabular-nums ${
                  surgeDirection === "up" ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {surgeDirection === "up" ? "↑" : "↓"}{" "}
                {surge != null ? Math.abs(Math.round(surge)) : 0}% vs prior window
              </p>
            )}
          </DrawerSection>
        )}

        {sevTotal > 0 && sevDist && (
          <DrawerSection title="Severity mix" caption={`${sevTotal} classified`}>
            <DistributionBar
              segments={SEVERITY_SEGMENTS.map((s) => ({
                ...s,
                count: sevDist[s.key as keyof typeof sevDist],
              }))}
              total={sevTotal}
            />
          </DrawerSection>
        )}

        {senTotal > 0 && senDist && (
          <DrawerSection title="Sentiment" caption={`${senTotal} classified`}>
            <DistributionBar
              segments={SENTIMENT_SEGMENTS.map((s) => ({
                ...s,
                count:
                  s.key === "positive"
                    ? senDist.positive
                    : s.key === "negative"
                      ? senDist.negative
                      : senDist.neutral,
              }))}
              total={senTotal}
            />
          </DrawerSection>
        )}

        <DrawerSection
          title="Top reports in this cluster"
          caption={isLoading ? "loading…" : `${top.length} of ${cluster.count}`}
        >
          <IssueList
            issues={top}
            onSelect={(i) => onSelectIssue(i.id)}
            emptyHint={
              isLoading ? "Loading…" : "No reports returned for this cluster."
            }
          />
        </DrawerSection>

        {cluster.why_surfaced && (
          <DrawerSection title="Why surfaced">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {cluster.why_surfaced}
            </p>
          </DrawerSection>
        )}
      </div>

      <footer className="mt-auto flex flex-col gap-2 border-t border-border/50 bg-card/40 p-4">
        <Button type="button" onClick={onOpenInTable} className="w-full justify-center gap-2">
          Open all {cluster.count} in table
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onOpenInTriage}
          className="w-full justify-center gap-2"
        >
          <Brain className="h-4 w-4" />
          Send to LLM triage
        </Button>
      </footer>
    </div>
  )
}
