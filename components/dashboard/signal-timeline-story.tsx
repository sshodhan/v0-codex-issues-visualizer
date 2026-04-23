"use client"

import { useMemo, useId } from "react"
import type { StoryTimelinePoint } from "@/lib/dashboard/story-timeline"
import { format, parseISO } from "date-fns"

const W = 720
const H = 480
const PAD_L = 88
const PAD_R = 16
const PAD_T = 24
const PAD_B = 24
const INNER_W = W - PAD_L - PAD_R
const INNER_H = H - PAD_T - PAD_B
const BINS = 28

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

export function SignalTimelineStory({
  points,
  timeLabel,
}: {
  points: StoryTimelinePoint[]
  timeLabel: string
}) {
  const id = useId()
  const placed = useMemo(() => placePoints(points), [points])
  const dateExtent = useMemo(() => {
    if (points.length === 0) return null
    const sorted = [...points].sort(
      (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
    )
    return { start: sorted[0].publishedAt, end: sorted[sorted.length - 1].publishedAt }
  }, [points])

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
          <defs>
            <filter id={`${id}-glow`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="1.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <line
            x1={PAD_L - 8}
            y1={PAD_T}
            x2={PAD_L - 8}
            y2={H - PAD_B}
            stroke="hsl(var(--border))"
            strokeWidth={1.5}
          />
          {dateExtent && (
            <>
              <text
                x={PAD_L - 12}
                y={PAD_T + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
                style={{ fontSize: 10 }}
              >
                {format(parseISO(dateExtent.end), "MMM d")}
              </text>
              <text
                x={PAD_L - 12}
                y={H - PAD_B - 4}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
                style={{ fontSize: 10 }}
              >
                {format(parseISO(dateExtent.start), "MMM d")}
              </text>
            </>
          )}
          {placed.map((p) => (
            <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
              <circle
                cx={p.cx}
                cy={p.cy}
                r={p.r}
                fill={p.categoryColor}
                fillOpacity={0.75}
                stroke="hsl(var(--background))"
                strokeWidth={1.2}
                filter={p.impact >= 7 ? `url(#${id}-glow)` : undefined}
              >
                <title>
                  {p.title}
                  {`\n`}Impact {p.impact.toFixed(1)} · {p.sourceSlug}
                  {p.errorCode ? `\nError: ${p.errorCode}` : ""}
                </title>
              </circle>
            </a>
          ))}
        </svg>
        <figcaption className="mt-2 text-xs text-muted-foreground text-center max-w-2xl mx-auto">
          Each dot is a public report in your filter. Size ≈ impact (1–10). Color = heuristic category. Vertical
          axis is time (newer near top). Bubbles in the same band group reports from nearby dates — similar in spirit
          to a beeswarm / &quot;gravity&quot; view.
        </figcaption>
      </figure>
    </div>
  )
}
