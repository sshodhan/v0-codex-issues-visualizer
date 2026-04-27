"use client"

import { useMemo } from "react"
import {
  groupCategoriesByCount,
  type StoryTimelinePoint,
} from "@/lib/dashboard/story-timeline"
import { differenceInCalendarDays, format, parseISO } from "date-fns"

const W = 720
const H = 480
const PAD_L = 88
const PAD_R = 16
const PAD_T = 28
const PAD_B = 28
const INNER_W = W - PAD_L - PAD_R
const INNER_H = H - PAD_T - PAD_B
const BINS = 28
const DAY_MS = 86_400_000

type Placed = StoryTimelinePoint & { cx: number; cy: number; r: number }

function placePoints(points: StoryTimelinePoint[]): Placed[] {
  if (points.length === 0) return []
  const bins: StoryTimelinePoint[][] = Array.from({ length: BINS }, () => [])
  for (const p of points) {
    const b = Math.min(BINS - 1, Math.floor(p.tNorm * BINS * 0.999999))
    bins[b].push(p)
  }
  const out: Placed[] = []
  for (let b = 0; b < BINS; b++) {
    const row = bins[b]
    if (row.length === 0) continue
    row.sort((a, c) => c.impact - a.impact)
    const tMid = (b + 0.5) / BINS
    // Newer = higher tNorm → top of chart
    const y = PAD_T + (1 - tMid) * INNER_H
    const n = row.length
    row.forEach((p, i) => {
      const slot = n === 1 ? 0.5 : (i + 0.5) / n
      const x = PAD_L + 6 + slot * (INNER_W - 12)
      const r = 4 + p.rScale * 10
      out.push({ ...p, cx: x, cy: y, r })
    })
  }
  return out
}

/** y-coordinate in the chart for a normalized time fraction (1 = newest = top). */
function yForFrac(frac: number): number {
  return PAD_T + (1 - Math.max(0, Math.min(1, frac))) * INNER_H
}

/** Pick ~6 evenly spaced dates across the extent for tick labels. */
function buildAxisTicks(startMs: number, endMs: number): Array<{ frac: number; date: Date }> {
  const span = Math.max(endMs - startMs, 1)
  const days = Math.max(1, Math.round(span / DAY_MS))
  // Aim for between 4 and 7 ticks; cap step at whole days for short ranges.
  const target = Math.min(7, Math.max(4, Math.round(days / 4) + 1))
  return Array.from({ length: target }, (_, i) => {
    const frac = i / (target - 1)
    return { frac, date: new Date(startMs + frac * span) }
  })
}

/**
 * Pick a date-fns format string sized to the time range so tick labels stay distinct.
 * Short windows (≤ 1.5 days) use clock time; multi-day windows use date+time; otherwise just date.
 */
function pickTickFormat(startMs: number, endMs: number): string {
  const span = Math.max(endMs - startMs, 1)
  const days = span / DAY_MS
  if (days <= 1.5) return "HH:mm"
  if (days <= 3.5) return "MMM d HH:mm"
  return "MMM d"
}

/**
 * Compute weekend bands within [startMs, endMs] as fraction ranges (0..1) of the time extent.
 * Each Saturday and Sunday becomes one band; bands are merged with neighbors implicitly because
 * they're rendered with low opacity.
 */
function buildWeekendBands(startMs: number, endMs: number): Array<{ f0: number; f1: number }> {
  const span = Math.max(endMs - startMs, 1)
  // Walk local-day midnights from the day containing startMs to the day containing endMs.
  const startDay = new Date(startMs)
  startDay.setHours(0, 0, 0, 0)
  const endDay = new Date(endMs)
  endDay.setHours(0, 0, 0, 0)
  const dayCount = differenceInCalendarDays(endDay, startDay) + 1
  if (dayCount > 200) return [] // safety: skip when range is huge
  const out: Array<{ f0: number; f1: number }> = []
  for (let i = 0; i < dayCount; i++) {
    const dayStart = new Date(startDay.getTime() + i * DAY_MS)
    const dow = dayStart.getDay()
    if (dow !== 0 && dow !== 6) continue
    const dayEnd = dayStart.getTime() + DAY_MS
    const f0 = Math.max(0, (dayStart.getTime() - startMs) / span)
    const f1 = Math.min(1, (dayEnd - startMs) / span)
    if (f1 > f0) out.push({ f0, f1 })
  }
  return out
}

/**
 * What to visually emphasize. Non-matching dots are drawn at low opacity so the
 * reader's eye locks onto the active selection while keeping spatial context.
 */
export type TimelineHighlight =
  | { kind: "heuristic"; slug: string }
  | { kind: "cluster"; clusterId: string }
  | { kind: "issue"; issueId: string }
  | null

function isMatch(p: StoryTimelinePoint, h: TimelineHighlight): boolean {
  if (!h) return true
  if (h.kind === "heuristic") return p.categorySlug === h.slug
  if (h.kind === "cluster") return p.clusterId === h.clusterId
  if (h.kind === "issue") return p.id === h.issueId
  return true
}

export function SignalTimelineStory({
  points,
  timeLabel,
  highlight = null,
  onSelectIssue,
}: {
  points: StoryTimelinePoint[]
  timeLabel: string
  highlight?: TimelineHighlight
  /** When provided, dots become buttons instead of external links. */
  onSelectIssue?: (issueId: string) => void
}) {
  const placed = useMemo(() => placePoints(points), [points])
  const extent = useMemo(() => {
    if (points.length === 0) return null
    let min = Infinity
    let max = -Infinity
    for (const p of points) {
      const t = new Date(p.publishedAt).getTime()
      if (t < min) min = t
      if (t > max) max = t
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    return { startMs: min, endMs: max }
  }, [points])
  const ticks = useMemo(
    () => (extent ? buildAxisTicks(extent.startMs, extent.endMs) : []),
    [extent],
  )
  const tickFormat = useMemo(
    () => (extent ? pickTickFormat(extent.startMs, extent.endMs) : "MMM d"),
    [extent],
  )
  const weekendBands = useMemo(
    () => (extent ? buildWeekendBands(extent.startMs, extent.endMs) : []),
    [extent],
  )
  const legend = useMemo(() => groupCategoriesByCount(points).slice(0, 6), [points])
  const highImpactCount = useMemo(
    () => placed.filter((p) => p.impact >= 7).length,
    [placed],
  )

  if (points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground border border-dashed rounded-lg p-8 text-center">
        No observations with dates in the current filter — widen the time range or check sync.
      </p>
    )
  }

  return (
    <div className="w-full overflow-x-auto">
      <figure className="min-w-[320px]">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto max-h-[min(70vh,520px)]"
          role="img"
          aria-label={`Signal cloud over time. ${points.length} points. ${timeLabel}.`}
        >
          {/* Weekend bands — drawn first so dots and gridlines sit on top */}
          {weekendBands.map((band, i) => {
            const yTop = yForFrac(band.f1)
            const yBot = yForFrac(band.f0)
            return (
              <rect
                key={`wk-${i}`}
                x={PAD_L}
                y={yTop}
                width={INNER_W}
                height={Math.max(0, yBot - yTop)}
                fill="hsl(var(--muted-foreground))"
                fillOpacity={0.05}
              />
            )
          })}

          {/* Horizontal gridlines + tick labels */}
          {ticks.map((t, i) => {
            const y = yForFrac(t.frac)
            return (
              <g key={`tick-${i}`}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={W - PAD_R}
                  y2={y}
                  stroke="hsl(var(--border))"
                  strokeWidth={1}
                  strokeDasharray={i === 0 || i === ticks.length - 1 ? undefined : "2 4"}
                  opacity={i === 0 || i === ticks.length - 1 ? 0.7 : 0.45}
                />
                <text
                  x={PAD_L - 10}
                  y={y + 3.5}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}
                >
                  {format(t.date, tickFormat)}
                </text>
              </g>
            )
          })}

          {/* Vertical axis line */}
          <line
            x1={PAD_L}
            y1={PAD_T}
            x2={PAD_L}
            y2={H - PAD_B}
            stroke="hsl(var(--border))"
            strokeWidth={1.25}
          />

          {/* "newer" / "older" anchor labels */}
          <text
            x={PAD_L - 10}
            y={PAD_T - 10}
            textAnchor="end"
            className="fill-muted-foreground"
            style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            Newer ↑
          </text>
          <text
            x={PAD_L - 10}
            y={H - PAD_B + 16}
            textAnchor="end"
            className="fill-muted-foreground"
            style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            Older ↓
          </text>

          {/* Halos for high-impact points (rendered behind the dots) */}
          {placed
            .filter((p) => p.impact >= 7)
            .map((p) => {
              const dim = highlight && !isMatch(p, highlight)
              return (
                <circle
                  key={`halo-${p.id}`}
                  cx={p.cx}
                  cy={p.cy}
                  r={p.r + 4}
                  fill="none"
                  stroke={p.categoryColor}
                  strokeOpacity={dim ? 0.06 : 0.25}
                  strokeWidth={2}
                  style={{ transition: "stroke-opacity 200ms ease" }}
                />
              )
            })}

          {/* Dots */}
          {placed.map((p) => {
            const dim = highlight && !isMatch(p, highlight)
            const fillOpacity = dim ? 0.14 : 0.85
            const titleEl = (
              <title>
                {p.title}
                {`\n`}
                {format(parseISO(p.publishedAt), "MMM d, yyyy")} · Impact {p.impact.toFixed(1)} ·{" "}
                {p.sourceSlug}
                {p.errorCode ? `\nError: ${p.errorCode}` : ""}
              </title>
            )
            const circle = (
              <circle
                cx={p.cx}
                cy={p.cy}
                r={p.r}
                fill={p.categoryColor}
                fillOpacity={fillOpacity}
                stroke="hsl(var(--background))"
                strokeWidth={1.2}
                style={{ transition: "fill-opacity 200ms ease" }}
              >
                {titleEl}
              </circle>
            )
            if (onSelectIssue) {
              return (
                <g
                  key={p.id}
                  className="cursor-pointer outline-none"
                  role="button"
                  tabIndex={0}
                  aria-label={`${p.title} — open detail`}
                  onClick={() => onSelectIssue(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onSelectIssue(p.id)
                    }
                  }}
                >
                  {circle}
                </g>
              )
            }
            return (
              <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                {circle}
              </a>
            )
          })}
        </svg>

        <figcaption className="mt-3 space-y-2 text-xs text-muted-foreground max-w-2xl mx-auto">
          <p className="text-center">
            Each dot is a public report in your filter ({points.length} shown). Size ≈ impact (1–10);
            high-impact dots (≥7) carry a halo
            {highImpactCount > 0 ? ` — ${highImpactCount} in this window` : ""}. Color = heuristic
            category. Weekend days are shaded faintly.
          </p>
          {legend.length > 0 && (
            <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
              {legend.map((c) => (
                <li key={c.name} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="text-foreground/80">{c.name}</span>
                  <span className="tabular-nums text-muted-foreground">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
        </figcaption>
      </figure>
    </div>
  )
}
