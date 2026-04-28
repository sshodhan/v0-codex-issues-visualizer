import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { ClusterTrustRibbon } from "./cluster-trust-ribbon"
import { MIN_DISPLAYABLE_LABEL_CONFIDENCE } from "@/lib/storage/cluster-label-fallback"
import type { ClusterRollupRow } from "@/hooks/use-dashboard-data"

interface FamilyCardProps {
  cluster: ClusterRollupRow
  days: number
  isLoudest?: boolean
  isFixFirst?: boolean
}

function getActionabilityColor(value: number): string {
  if (value >= 0.67) return "bg-green-500"
  if (value >= 0.34) return "bg-amber-500"
  return "bg-red-500"
}

export function FamilyCard({ cluster, days, isLoudest, isFixFirst }: FamilyCardProps) {
  const isSingleton = cluster.count <= 1
  const hasDisplayableClusterLabel =
    !!cluster.label &&
    cluster.label_confidence != null &&
    cluster.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE
  // For singletons the representative title is more informative than a
  // generic "Bug cluster · …" rollup, so prefer it. For multi-issue
  // families we prefer the cluster label (LLM or deterministic fallback)
  // because it explains what unifies the members.
  const familyLabel = isSingleton
    ? cluster.representative_title || (hasDisplayableClusterLabel ? cluster.label! : `Cluster #${cluster.id.slice(0, 8)}`)
    : hasDisplayableClusterLabel
      ? cluster.label!
      : cluster.representative_title || `Cluster #${cluster.id.slice(0, 8)}`

  const actionability = cluster.rail_scoring?.actionability_input ?? 0
  const actionabilityPct = Math.round(actionability * 100)
  const avgImpact = cluster.avg_impact

  return (
    <Link href={`/families/${cluster.id}?days=${days}`} className="block">
      <Card className="h-full transition-colors hover:border-primary/60 hover:bg-muted/30">
        <CardContent className="p-4 space-y-2">
          {/* Badges row */}
          {(isLoudest || isFixFirst || isSingleton) && (
            <div className="flex items-center gap-1.5">
              {isLoudest && (
                <Badge className="bg-amber-500 hover:bg-amber-600 text-white text-[10px] px-1.5 py-0">
                  FREQUENT
                </Badge>
              )}
              {isFixFirst && (
                <Badge className="bg-green-600 hover:bg-green-700 text-white text-[10px] px-1.5 py-0">
                  FIX FIRST
                </Badge>
              )}
              {isSingleton && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                  SINGLETON
                </Badge>
              )}
            </div>
          )}

          {/* Family label */}
          <p className="font-medium line-clamp-2">{familyLabel}</p>

          {/* Stats line */}
          <p className="text-xs text-muted-foreground">
            {cluster.count} observations · {cluster.classified_count} triaged ·{" "}
            {cluster.source_count ?? 0} sources
          </p>

          {/* Actionability progress bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Actionability</span>
              <span>{actionabilityPct}%</span>
            </div>
            <Progress
              value={actionabilityPct}
              className="h-1.5"
              indicatorClassName={getActionabilityColor(actionability)}
            />
            {avgImpact != null && (
              <p className="text-[10px] text-muted-foreground">
                Avg impact: <span className="font-medium text-foreground/80">{avgImpact.toFixed(1)}</span>
              </p>
            )}
          </div>

          {/* Trust ribbon */}
          <ClusterTrustRibbon cluster={cluster} />

          {/* Drill-down affordance */}
          <p className="pt-1 text-[11px] font-medium text-primary">
            {isSingleton
              ? "View observation →"
              : `View ${cluster.count} observation${cluster.count === 1 ? "" : "s"} →`}
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}

interface TopFamiliesSectionProps {
  clusters: ClusterRollupRow[]
  days: number
  onScrollToIssuesTable?: () => void
}

const MIN_FREQUENT_THRESHOLD = 5

/**
 * Computes badge assignments for top families:
 * - FREQUENT: Top 3 by observation count (only if count >= 5)
 * - FIX FIRST: Top 3 by actionability_input
 */
function computeBadgeAssignments(clusters: ClusterRollupRow[]) {
  const top6 = clusters.slice(0, 6)
  
  // Top 3 by count (FREQUENT) - only if they meet the minimum threshold
  const byCount = [...top6].sort((a, b) => b.count - a.count)
  const frequentIds = new Set(
    byCount
      .slice(0, 3)
      .filter((c) => c.count >= MIN_FREQUENT_THRESHOLD)
      .map((c) => c.id)
  )

  // Top 3 by actionability (FIX FIRST)
  const byActionability = [...top6].sort((a, b) => {
    const aVal = a.rail_scoring?.actionability_input ?? 0
    const bVal = b.rail_scoring?.actionability_input ?? 0
    return bVal - aVal
  })
  const fixFirstIds = new Set(byActionability.slice(0, 3).map((c) => c.id))

  return { frequentIds, fixFirstIds }
}

export function TopFamiliesSection({ clusters, days, onScrollToIssuesTable }: TopFamiliesSectionProps) {
  const top6 = clusters.slice(0, 6)
  const { frequentIds, fixFirstIds } = computeBadgeAssignments(clusters)

  if (top6.length === 0) return null

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">Top Families</h3>
          <p className="text-sm text-muted-foreground">
            Semantic clusters ranked by volume. FREQUENT = 5+ observations. FIX FIRST = highest actionability.
          </p>
        </div>
        {onScrollToIssuesTable && (
          <button
            type="button"
            onClick={onScrollToIssuesTable}
            className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            Jump to issues table
          </button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {top6.map((cluster) => (
          <FamilyCard
            key={cluster.id}
            cluster={cluster}
            days={days}
            isLoudest={frequentIds.has(cluster.id)}
            isFixFirst={fixFirstIds.has(cluster.id)}
          />
        ))}
      </div>
    </section>
  )
}
