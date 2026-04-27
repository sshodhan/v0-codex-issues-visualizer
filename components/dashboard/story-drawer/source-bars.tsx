import type { SourceCount } from "@/lib/dashboard/story-drawer-data"

/**
 * Mini horizontal bar list — one row per source. Bar widths share the row's max count
 * so the longest bar fills the row. Numbers are right-aligned and tabular for scanning.
 */
export function SourceBars({ sources }: { sources: SourceCount[] }) {
  if (sources.length === 0) {
    return <p className="text-xs italic text-muted-foreground">No sources in this window.</p>
  }
  const max = Math.max(1, ...sources.map((s) => s.count))
  return (
    <ul className="space-y-1.5">
      {sources.map((s) => {
        const pct = (s.count / max) * 100
        return (
          <li key={s.slug} className="grid grid-cols-[7rem_1fr_2.25rem] items-center gap-2 text-xs">
            <span className="truncate text-foreground/80" title={s.name}>
              {s.name}
            </span>
            <span className="block h-2 rounded-sm bg-muted/40" aria-hidden>
              <span
                className="block h-full rounded-sm bg-primary/70"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="text-right tabular-nums text-muted-foreground">{s.count}</span>
          </li>
        )
      })}
    </ul>
  )
}
