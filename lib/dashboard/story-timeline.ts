import type { Issue } from "@/hooks/use-dashboard-data"

export interface StoryTimelinePoint {
  id: string
  title: string
  url: string
  publishedAt: string
  impact: number
  /** 0..1 vertical position in range (top = start of window) */
  tNorm: number
  categoryName: string
  categorySlug: string
  categoryColor: string
  sourceSlug: string
  errorCode: string | null
  /** Layer-A cluster id (when joined) — used for cross-filter highlight */
  clusterId: string | null
  /** Family/cluster label for family-based view */
  familyName: string
  /** Family color for family-based view (generated from clusterId) */
  familyColor: string
  /** 0..1 radius scale for drawing */
  rScale: number
}

const MAX_POINTS = 240

/** Cluster info for family-based grouping */
export interface ClusterInfo {
  id: string
  label: string | null
}

/** Generate a deterministic color from a cluster ID */
function clusterIdToColor(clusterId: string): string {
  // Use a hash of the cluster ID to pick from a palette
  let hash = 0
  for (let i = 0; i < clusterId.length; i++) {
    hash = clusterId.charCodeAt(i) + ((hash << 5) - hash)
  }
  // Palette of distinct, accessible colors for families
  const palette = [
    "#3b82f6", // blue
    "#10b981", // emerald
    "#f59e0b", // amber
    "#ef4444", // red
    "#8b5cf6", // violet
    "#06b6d4", // cyan
    "#f97316", // orange
    "#ec4899", // pink
    "#84cc16", // lime
    "#6366f1", // indigo
    "#14b8a6", // teal
    "#a855f7", // purple
  ]
  return palette[Math.abs(hash) % palette.length]
}

/**
 * Map issues to a vertical timeline. Same rows as the issues table; cap for SVG perf.
 * @param clusterLookup Optional map from cluster ID to cluster info for family labels
 */
export function buildStoryTimeline(
  issues: Issue[],
  clusterLookup?: Map<string, ClusterInfo>
): StoryTimelinePoint[] {
  if (issues.length === 0) return []

  const withDates = issues.filter((i) => i.published_at)
  if (withDates.length === 0) return []

  const sorted = [...withDates].sort(
    (a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime()
  )
  const capped = sorted.length > MAX_POINTS ? sorted.slice(-MAX_POINTS) : sorted

  const times = capped.map((i) => new Date(i.published_at).getTime())
  const tMin = Math.min(...times)
  const tMax = Math.max(...times)
  const span = Math.max(tMax - tMin, 1)

  return capped.map((i) => {
    const t = new Date(i.published_at).getTime()
    const tNorm = (t - tMin) / span
    const impact = Number(i.impact_score) || 1
    const rScale = Math.min(1, Math.max(0.2, impact / 10))
    const clusterId = i.cluster_id ?? null
    const clusterInfo = clusterId ? clusterLookup?.get(clusterId) : null
    const familyName = clusterInfo?.label || (clusterId ? "Unlabelled Family" : "Unclustered")
    const familyColor = clusterId ? clusterIdToColor(clusterId) : "#6b7280"
    return {
      id: i.id,
      title: i.title,
      url: i.url,
      publishedAt: i.published_at,
      impact,
      tNorm,
      categoryName: i.category?.name ?? "Uncategorized",
      categorySlug: i.category?.slug ?? "uncategorized",
      categoryColor: i.category?.color ?? "#6b7280",
      sourceSlug: i.source?.slug ?? "unknown",
      errorCode: i.error_code ?? null,
      clusterId,
      familyName,
      familyColor,
      rScale,
    }
  })
}

export function groupCategoriesByCount(points: StoryTimelinePoint[]): { name: string; color: string; count: number }[] {
  const m = new Map<string, { name: string; color: string; count: number }>()
  for (const p of points) {
    const k = p.categoryName
    const cur = m.get(k) ?? { name: k, color: p.categoryColor, count: 0 }
    cur.count += 1
    m.set(k, cur)
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count)
}

export function groupFamiliesByCount(points: StoryTimelinePoint[]): { name: string; color: string; count: number }[] {
  const m = new Map<string, { name: string; color: string; count: number }>()
  for (const p of points) {
    const k = p.familyName
    const cur = m.get(k) ?? { name: k, color: p.familyColor, count: 0 }
    cur.count += 1
    m.set(k, cur)
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count)
}
