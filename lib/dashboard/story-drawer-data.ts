/**
 * Pure aggregation helpers for the Story tab drawer. All client-side; consume the
 * already-loaded `issues[]` array so a drawer open does not trigger a fetch.
 */

import type { Issue } from "@/hooks/use-dashboard-data"

const DAY_MS = 86_400_000

export interface SparklinePoint {
  /** Local-day midnight as ms */
  dayMs: number
  count: number
}

/**
 * Daily-bucket counts of issues over the [startMs, endMs] window. Always returns
 * one bucket per calendar day in the range, including zero-count days, so the
 * sparkline reads as a proper time series.
 */
export function bucketByDay(
  issues: Issue[],
  startMs: number,
  endMs: number,
): SparklinePoint[] {
  const start = new Date(startMs)
  start.setHours(0, 0, 0, 0)
  const end = new Date(endMs)
  end.setHours(0, 0, 0, 0)
  const dayCount = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1)
  const buckets: SparklinePoint[] = Array.from({ length: dayCount }, (_, i) => ({
    dayMs: start.getTime() + i * DAY_MS,
    count: 0,
  }))
  for (const i of issues) {
    if (!i.published_at) continue
    const t = new Date(i.published_at).getTime()
    if (Number.isNaN(t)) continue
    const idx = Math.floor((t - start.getTime()) / DAY_MS)
    if (idx >= 0 && idx < buckets.length) buckets[idx].count += 1
  }
  return buckets
}

export interface SentimentSplit {
  positive: number
  neutral: number
  negative: number
  total: number
}

export function sentimentSplit(issues: Issue[]): SentimentSplit {
  let positive = 0
  let neutral = 0
  let negative = 0
  for (const i of issues) {
    if (i.sentiment === "positive") positive += 1
    else if (i.sentiment === "negative") negative += 1
    else neutral += 1
  }
  return { positive, neutral, negative, total: positive + neutral + negative }
}

export interface SourceCount {
  slug: string
  name: string
  count: number
}

export function topSources(issues: Issue[], limit = 5): SourceCount[] {
  const m = new Map<string, SourceCount>()
  for (const i of issues) {
    const slug = i.source?.slug ?? "unknown"
    const name = i.source?.name ?? "Unknown"
    const cur = m.get(slug) ?? { slug, name, count: 0 }
    cur.count += 1
    m.set(slug, cur)
  }
  return Array.from(m.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

export interface ErrorCodeCount {
  code: string
  count: number
}

export function topErrorCodes(issues: Issue[], limit = 8): ErrorCodeCount[] {
  const m = new Map<string, ErrorCodeCount>()
  for (const i of issues) {
    const code = i.error_code?.trim()
    if (!code) continue
    const cur = m.get(code) ?? { code, count: 0 }
    cur.count += 1
    m.set(code, cur)
  }
  return Array.from(m.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

export function topByImpact(issues: Issue[], limit = 5): Issue[] {
  return [...issues]
    .filter((i) => Number.isFinite(i.impact_score))
    .sort((a, b) => (b.impact_score ?? 0) - (a.impact_score ?? 0))
    .slice(0, limit)
}

/** Issues that match a heuristic category slug. */
export function filterByHeuristic(issues: Issue[], slug: string): Issue[] {
  return issues.filter((i) => i.category?.slug === slug)
}

/** Issues that match an LLM category slug (lowercase, hyphen-or-underscore tolerant). */
export function filterByLlm(issues: Issue[], slug: string): Issue[] {
  const target = slug.trim().toLowerCase()
  return issues.filter((i) => {
    const v = i.llm_primary_tag?.trim().toLowerCase()
    return v === target
  })
}

/** Issues belonging to a given Layer-A cluster. */
export function filterByCluster(issues: Issue[], clusterId: string): Issue[] {
  return issues.filter((i) => i.cluster_id === clusterId)
}

/** Format a percentage 0..1 into "42%". Returns null for invalid inputs. */
export function formatPct(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null
  return `${Math.round(v * 100)}%`
}
