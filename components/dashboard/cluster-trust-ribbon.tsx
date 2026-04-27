import { Badge } from "@/components/ui/badge"
import type { ClusterRollupRow, ClusterSummary } from "@/hooks/use-dashboard-data"

type ClusterTrustLike = Pick<
  ClusterSummary,
  | "cluster_path"
  | "fingerprint_hit_rate"
  | "dominant_error_code_share"
  | "dominant_stack_frame_share"
  | "intra_cluster_similarity_proxy"
  | "nearest_cluster_gap_proxy"
  | "reviewed_count"
  | "classified_count"
> | Pick<
  ClusterRollupRow,
  | "cluster_path"
  | "fingerprint_hit_rate"
  | "dominant_error_code_share"
  | "dominant_stack_frame_share"
  | "intra_cluster_similarity_proxy"
  | "nearest_cluster_gap_proxy"
  | "reviewed_count"
  | "classified_count"
>

function pct(v: number) {
  return `${Math.round(v * 100)}%`
}

export function ClusterTrustRibbon({
  cluster,
  showTechnicalChips = true,
  showCoreChips = true,
}: {
  cluster: ClusterTrustLike
  showTechnicalChips?: boolean
  showCoreChips?: boolean
}) {
  const dominant = Math.max(cluster.dominant_error_code_share, cluster.dominant_stack_frame_share)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showCoreChips ? (
        <>
          <Badge variant={cluster.cluster_path === "semantic" ? "default" : "outline"}>
            {cluster.cluster_path === "semantic" ? "AI-grouped" : "title fallback"}
          </Badge>
          <Badge variant="secondary">reviewed {cluster.reviewed_count}/{cluster.classified_count}</Badge>
        </>
      ) : null}
      {showTechnicalChips ? (
        <>
          <Badge variant="secondary">fp hit {pct(cluster.fingerprint_hit_rate)}</Badge>
          <Badge variant="outline">dominant {pct(dominant)}</Badge>
          <Badge variant="outline">cohesion {pct(cluster.intra_cluster_similarity_proxy)}</Badge>
          <Badge variant="outline">gap {pct(cluster.nearest_cluster_gap_proxy)}</Badge>
        </>
      ) : null}
    </div>
  )
}
