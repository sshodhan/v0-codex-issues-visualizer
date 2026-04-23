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
  categoryColor: string
  sourceSlug: string
  errorCode: string | null
  /** 0..1 radius scale for drawing */
  rScale: number
}

const MAX_POINTS = 240

/**
 * Map issues to a vertical timeline. Same rows as the issues table; cap for SVG perf.
 */
export function buildStoryTimeline(issues: Issue[]): StoryTimelinePoint[] {
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
    return {
      id: i.id,
      title: i.title,
      url: i.url,
      publishedAt: i.published_at,
      impact,
      tNorm,
      categoryName: i.category?.name ?? "Uncategorized",
      categoryColor: i.category?.color ?? "#6b7280",
      sourceSlug: i.source?.slug ?? "unknown",
      errorCode: i.error_code ?? null,
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
