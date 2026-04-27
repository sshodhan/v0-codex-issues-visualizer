import type { StoryTimelinePoint } from "./story-timeline"

const DAY_MS = 86_400_000

/** A single category's share of the peak day. */
export interface PeakCategory {
  name: string
  color: string
  count: number
  share: number
}

export type StoryLedeKind = "peak" | "surge" | "quiet" | "empty"

export interface LedeFacts {
  kind: StoryLedeKind
  /** Total reports in window (always present unless kind === "empty"). */
  total: number
  /** Window length in days, rounded. */
  spanDays: number

  /** "peak" / "surge" / "quiet" all carry these for the chart annotation. */
  peakDayMs?: number
  /** 0..1 fraction of the window — used by the timeline to position the band. */
  peakDayFrac?: number
  peakCount?: number
  peakDominant?: PeakCategory

  /** "surge" carries period comparison. */
  recentCount?: number
  priorCount?: number
  deltaPct?: number

  /** The editorial copy. Always present; renders as serif lede. */
  headline: string
  /** Optional second line (caption). */
  subhead?: string
}

interface DayBucket {
  dayMs: number
  count: number
  byCategory: Map<string, { name: string; color: string; count: number }>
}

function bucketDays(
  points: StoryTimelinePoint[],
  startMs: number,
  endMs: number,
): DayBucket[] {
  const start = new Date(startMs)
  start.setHours(0, 0, 0, 0)
  const end = new Date(endMs)
  end.setHours(0, 0, 0, 0)
  const dayCount = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1)
  const buckets: DayBucket[] = Array.from({ length: dayCount }, (_, i) => ({
    dayMs: start.getTime() + i * DAY_MS,
    count: 0,
    byCategory: new Map(),
  }))
  for (const p of points) {
    if (!p.publishedAt) continue
    const t = new Date(p.publishedAt).getTime()
    if (Number.isNaN(t)) continue
    const idx = Math.floor((t - start.getTime()) / DAY_MS)
    if (idx < 0 || idx >= buckets.length) continue
    const b = buckets[idx]
    b.count += 1
    const key = p.categoryName ?? "Uncategorized"
    const cur = b.byCategory.get(key) ?? {
      name: key,
      color: p.categoryColor ?? "#6b7280",
      count: 0,
    }
    cur.count += 1
    b.byCategory.set(key, cur)
  }
  return buckets
}

function dominantCategory(b: DayBucket): PeakCategory | undefined {
  if (b.byCategory.size === 0) return undefined
  let top: { name: string; color: string; count: number } | null = null
  for (const v of b.byCategory.values()) {
    if (!top || v.count > top.count) top = v
  }
  if (!top) return undefined
  return {
    name: top.name,
    color: top.color,
    count: top.count,
    share: b.count > 0 ? top.count / b.count : 0,
  }
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric" })
}

/**
 * Compute an editorial lede summarising the window. Picks the most newsworthy frame
 * (peak day, surge vs prior, or quiet) and produces a short, specific sentence.
 *
 * Pure function — given the same points + window, returns the same lede. Empty / flat
 * windows fall back to honest copy ("quiet" / "empty") rather than fabricating drama.
 */
export function computeStoryLede(
  points: StoryTimelinePoint[],
  windowMs: { startMs: number; endMs: number },
): LedeFacts {
  const total = points.length
  const spanDays = Math.max(
    1,
    Math.round((windowMs.endMs - windowMs.startMs) / DAY_MS) + 1,
  )

  if (total === 0) {
    return {
      kind: "empty",
      total: 0,
      spanDays,
      headline: "No reports landed in this window.",
      subhead: "Try widening the window above to see signal.",
    }
  }

  const buckets = bucketDays(points, windowMs.startMs, windowMs.endMs)
  const nonEmpty = buckets.filter((b) => b.count > 0)
  const peak = buckets.reduce((acc, b) => (b.count > acc.count ? b : acc), buckets[0])
  const peakFrac =
    windowMs.endMs > windowMs.startMs
      ? Math.max(
          0,
          Math.min(
            1,
            (peak.dayMs + DAY_MS / 2 - windowMs.startMs) /
              (windowMs.endMs - windowMs.startMs),
          ),
        )
      : 0.5
  const peakDom = dominantCategory(peak)

  // Period comparison: split window in half, compare second half to first.
  const mid = (windowMs.startMs + windowMs.endMs) / 2
  let recentCount = 0
  let priorCount = 0
  for (const p of points) {
    const t = new Date(p.publishedAt).getTime()
    if (Number.isNaN(t)) continue
    if (t >= mid) recentCount += 1
    else priorCount += 1
  }
  const deltaPct =
    priorCount > 0 ? ((recentCount - priorCount) / priorCount) * 100 : null

  // Decide framing.
  // — "quiet" wins when total is too small to make a confident claim.
  // — "peak" wins when one day stands out (>= 1.5× median non-empty day).
  // — "surge" wins when period-over-period delta is meaningful (|Δ| ≥ 25%).
  // — fallback: peak (every dataset has a busiest day).
  const sortedNonEmpty = [...nonEmpty].sort((a, b) => a.count - b.count)
  const median =
    sortedNonEmpty.length === 0
      ? 0
      : sortedNonEmpty[Math.floor(sortedNonEmpty.length / 2)].count
  const peakStandsOut = nonEmpty.length >= 2 && peak.count >= median * 1.5 + 1

  if (total < 5) {
    return {
      kind: "quiet",
      total,
      spanDays,
      peakDayMs: peak.dayMs,
      peakDayFrac: peakFrac,
      peakCount: peak.count,
      peakDominant: peakDom,
      headline: `A quiet window — ${total} ${total === 1 ? "report" : "reports"} across ${spanDays} days.`,
      subhead: peakDom
        ? `${peakDom.name} accounted for the most.`
        : "No clear pattern.",
    }
  }

  const surgeMeaningful = deltaPct !== null && Math.abs(deltaPct) >= 25
  const useSurge = surgeMeaningful && !peakStandsOut

  if (useSurge && deltaPct !== null) {
    const up = deltaPct > 0
    const verb = up ? "Reports climbed" : "Reports dropped"
    const lead = peakDom
      ? `${peakDom.name} led the change.`
      : "No single category dominated."
    return {
      kind: "surge",
      total,
      spanDays,
      peakDayMs: peak.dayMs,
      peakDayFrac: peakFrac,
      peakCount: peak.count,
      peakDominant: peakDom,
      recentCount,
      priorCount,
      deltaPct,
      headline: `${verb} ${Math.round(Math.abs(deltaPct))}% in the latest half of the window — ${recentCount} reports vs ${priorCount} before.`,
      subhead: lead,
    }
  }

  // Default: peak-day frame.
  const sharePct = peakDom ? Math.round(peakDom.share * 100) : 0
  const peakLabel = formatDay(peak.dayMs)
  const dominantLine =
    peakDom && sharePct > 0
      ? `${peakDom.name} accounted for ${sharePct}%.`
      : undefined
  return {
    kind: "peak",
    total,
    spanDays,
    peakDayMs: peak.dayMs,
    peakDayFrac: peakFrac,
    peakCount: peak.count,
    peakDominant: peakDom,
    headline: `${peakLabel} was the busiest day of the window — ${peak.count} ${
      peak.count === 1 ? "report" : "reports"
    }.`,
    subhead: dominantLine,
  }
}
