import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { ClusterTrustRibbon } from "./cluster-trust-ribbon"
import type { ClusterRollupRow } from "@/hooks/use-dashboard-data"

const MIN_DISPLAYABLE_LABEL_CONFIDENCE = 0.6

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
  const familyLabel =
    cluster.label &&
    cluster.label_confidence != null &&
    cluster.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE
      ? cluster.label
      : cluster.representative_title || `Cluster #${cluster.id.slice(0, 8)}`

  const actionability = cluster.rail_scoring?.actionability_input ?? 0
  const actionabilityPct = Math.round(actionability * 100)

  return (
    <Link href={`/families/${cluster.id}?days=${days}`} className="block">
      <Card className="h-full transition-colors hover:border-primary/60 hover:bg-muted/30">
        <CardContent className="p-4 space-y-2">
          {/* Badges row */}
          {(isLoudest || isFixFirst) && (
            <div className="flex items-center gap-1.5">
              {isLoudest && (
                <Badge className="bg-amber-500 hover:bg-amber-600 text-white text-[10px] px-1.5 py-0">
                  LOUDEST
                </Badge>
              )}
              {isFixFirst && (
                <Badge className="bg-green-600 hover:bg-green-700 text-white text-[10px] px-1.5 py-0">
                  FIX FIRST
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
          </div>

          {/* Trust ribbon */}
          <ClusterTrustRibbon cluster={cluster} />
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

/**
 * Computes badge assignments for top families:
 * - LOUDEST: Top 3 by observation count
 * - FIX FIRST: Top 3 by actionability_input
 */
function computeBadgeAssignments(clusters: ClusterRollupRow[]) {
  const top6 = clusters.slice(0, 6)
  
  // Top 3 by count (LOUDEST)
  const byCount = [...top6].sort((a, b) => b.count - a.count)
  const loudestIds = new Set(byCount.slice(0, 3).map((c) => c.id))

  // Top 3 by actionability (FIX FIRST)
  const byActionability = [...top6].sort((a, b) => {
    const aVal = a.rail_scoring?.actionability_input ?? 0
    const bVal = b.rail_scoring?.actionability_input ?? 0
    return bVal - aVal
  })
  const fixFirstIds = new Set(byActionability.slice(0, 3).map((c) => c.id))

  return { loudestIds, fixFirstIds }
}

export function TopFamiliesSection({ clusters, days, onScrollToIssuesTable }: TopFamiliesSectionProps) {
  const top6 = clusters.slice(0, 6)
  const { loudestIds, fixFirstIds } = computeBadgeAssignments(clusters)

  if (top6.length === 0) return null

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">Top Families</h3>
          <p className="text-sm text-muted-foreground">
            Semantic clusters ranked by volume. LOUDEST = most observations. FIX FIRST = highest actionability.
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
            isLoudest={loudestIds.has(cluster.id)}
            isFixFirst={fixFirstIds.has(cluster.id)}
          />
        ))}
      </div>
    </section>
  )
}
