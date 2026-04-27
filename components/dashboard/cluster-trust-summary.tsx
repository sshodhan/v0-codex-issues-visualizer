import { Badge } from "@/components/ui/badge"
import type { ClusterRollupRow, ClusterSummary } from "@/hooks/use-dashboard-data"

type ClusterTrustLike = Pick<
  ClusterSummary,
  | "cluster_path"
  | "fingerprint_hit_rate"
  | "reviewed_count"
  | "classified_count"
  | "total_observations"
> | Pick<
  ClusterRollupRow,
  | "cluster_path"
  | "fingerprint_hit_rate"
  | "reviewed_count"
  | "classified_count"
  | "count"
>

function clamp(value: number) {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function pct(value: number) {
  return `${Math.round(clamp(value) * 100)}%`
}

function summarizeTrustLabel(classifiedShare: number, reviewedShare: number, fingerprintHitRate: number) {
  const score = classifiedShare * 0.4 + reviewedShare * 0.4 + fingerprintHitRate * 0.2
  if (score >= 0.75) return { label: "Strong signal", variant: "default" as const }
  if (score >= 0.45) return { label: "Building signal", variant: "secondary" as const }
  return { label: "Early signal", variant: "outline" as const }
}

export function ClusterTrustSummary({
  cluster,
  showGroupingLabel = true,
}: {
  cluster: ClusterTrustLike
  showGroupingLabel?: boolean
}) {
  const total = "count" in cluster ? cluster.count : cluster.total_observations
  const classifiedShare = total > 0 ? cluster.classified_count / total : 0
  const reviewedShare = total > 0 ? cluster.reviewed_count / total : 0
  const fingerprintHitRate = clamp(cluster.fingerprint_hit_rate)
  const trust = summarizeTrustLabel(classifiedShare, reviewedShare, fingerprintHitRate)

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showGroupingLabel ? (
        <Badge variant={cluster.cluster_path === "semantic" ? "default" : "outline"}>
          {cluster.cluster_path === "semantic" ? "Grouped by meaning" : "Grouped by title"}
        </Badge>
      ) : null}
      <Badge variant="secondary">{pct(classifiedShare)} triaged</Badge>
      <Badge variant="secondary">{pct(reviewedShare)} reviewed</Badge>
      <Badge variant="outline">{pct(fingerprintHitRate)} pattern coverage</Badge>
      <Badge variant={trust.variant}>{trust.label}</Badge>
    </div>
  )
}
