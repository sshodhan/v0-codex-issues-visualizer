/**
 * Horizontal stacked bar for small N-way distributions (sentiment, severity).
 * Always renders all segments — zero-share segments collapse to zero width but keep their
 * legend entry so the reader can see "this segment has none."
 */
export function DistributionBar({
  segments,
  total,
  height = 8,
}: {
  segments: Array<{ key: string; label: string; count: number; className: string }>
  total: number
  height?: number
}) {
  if (total <= 0) {
    return (
      <p className="text-xs italic text-muted-foreground">No data.</p>
    )
  }
  return (
    <div className="space-y-2">
      <div
        className="flex w-full overflow-hidden rounded-full bg-muted/40"
        style={{ height }}
        role="img"
        aria-label={segments
          .map((s) => `${s.label} ${s.count} of ${total}`)
          .join(", ")}
      >
        {segments.map((s) => {
          const pct = (s.count / total) * 100
          if (pct <= 0) return null
          return (
            <div
              key={s.key}
              className={s.className}
              style={{ width: `${pct}%` }}
              title={`${s.label}: ${s.count} (${Math.round(pct)}%)`}
            />
          )
        })}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {segments.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`inline-block h-2 w-2 rounded-sm ${s.className}`} />
            <span className="text-foreground/80">{s.label}</span>
            <span className="tabular-nums">
              {s.count}
              {total > 0 ? ` (${Math.round((s.count / total) * 100)}%)` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
