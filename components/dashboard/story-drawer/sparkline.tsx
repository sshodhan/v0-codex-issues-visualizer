"use client"

import { useMemo } from "react"
import { format } from "date-fns"
import type { SparklinePoint } from "@/lib/dashboard/story-drawer-data"

/**
 * Tiny SVG sparkline. Pure vanilla — no Recharts overhead for a 14×360 vis. Renders an
 * area path under the line and emphasises the latest two points so a recent spike reads.
 *
 * Data is presented as-is (no smoothing); the caption summarises the window.
 */
export function Sparkline({
  data,
  color = "currentColor",
  height = 56,
  width = 360,
}: {
  data: SparklinePoint[]
  color?: string
  height?: number
  width?: number
}) {
  const { linePath, areaPath, lastPoint, peakPoint, peakLabel, total } = useMemo(() => {
    if (data.length === 0) {
      return {
        linePath: "",
        areaPath: "",
        lastPoint: null,
        peakPoint: null,
        peakLabel: "",
        total: 0,
      }
    }
    const max = Math.max(1, ...data.map((d) => d.count))
    const padX = 2
    const padY = 4
    const w = width - padX * 2
    const h = height - padY * 2
    const xs = data.map((_, i) => padX + (i / Math.max(1, data.length - 1)) * w)
    const ys = data.map((d) => padY + (1 - d.count / max) * h)

    const lp =
      data.length === 1
        ? `M ${xs[0]} ${ys[0]} L ${xs[0]} ${ys[0]}`
        : xs.map((x, i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${ys[i].toFixed(2)}`).join(" ")
    const ap = `${lp} L ${xs[xs.length - 1].toFixed(2)} ${(padY + h).toFixed(2)} L ${xs[0].toFixed(
      2,
    )} ${(padY + h).toFixed(2)} Z`

    let peakIdx = 0
    for (let i = 1; i < data.length; i++) {
      if (data[i].count > data[peakIdx].count) peakIdx = i
    }
    return {
      linePath: lp,
      areaPath: ap,
      lastPoint: { x: xs[xs.length - 1], y: ys[ys.length - 1], count: data[data.length - 1].count },
      peakPoint: { x: xs[peakIdx], y: ys[peakIdx], count: data[peakIdx].count },
      peakLabel:
        data[peakIdx].count === 0
          ? ""
          : `${data[peakIdx].count} on ${format(new Date(data[peakIdx].dayMs), "MMM d")}`,
      total: data.reduce((s, d) => s + d.count, 0),
    }
  }, [data, height, width])

  if (data.length === 0) {
    return (
      <p className="text-xs italic text-muted-foreground">No daily data in this window.</p>
    )
  }

  return (
    <figure className="space-y-1.5">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full h-auto"
        role="img"
        aria-label={`Sparkline: ${total} reports across ${data.length} days, peak ${peakLabel}.`}
      >
        <path d={areaPath} fill={color} fillOpacity={0.12} />
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        {peakPoint && peakPoint.count > 0 && (
          <circle
            cx={peakPoint.x}
            cy={peakPoint.y}
            r={2.5}
            fill={color}
            stroke="hsl(var(--background))"
            strokeWidth={1}
          />
        )}
        {lastPoint && (
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={2.5}
            fill="hsl(var(--background))"
            stroke={color}
            strokeWidth={1.5}
          />
        )}
      </svg>
      <figcaption className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>
          {format(new Date(data[0].dayMs), "MMM d")} —{" "}
          {format(new Date(data[data.length - 1].dayMs), "MMM d")}
        </span>
        <span>
          {total} total{peakLabel ? ` · peak ${peakLabel}` : ""}
        </span>
      </figcaption>
    </figure>
  )
}
