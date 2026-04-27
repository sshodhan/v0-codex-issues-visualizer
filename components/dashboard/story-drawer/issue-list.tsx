import { ExternalLink } from "lucide-react"
import { format, parseISO } from "date-fns"
import type { Issue } from "@/hooks/use-dashboard-data"

/**
 * Compact list of representative issues. Each row is a link to the original URL — keeps the
 * drawer read-only and doesn't pretend to be a full triage UI.
 */
export function IssueList({
  issues,
  onSelect,
  emptyHint = "No representative reports.",
}: {
  issues: Issue[]
  /** Optional: open the issue inside the drawer (else falls back to URL link). */
  onSelect?: (issue: Issue) => void
  emptyHint?: string
}) {
  if (issues.length === 0) {
    return <p className="text-xs italic text-muted-foreground">{emptyHint}</p>
  }
  return (
    <ul className="space-y-2">
      {issues.map((i) => {
        const date = i.published_at ? format(parseISO(i.published_at), "MMM d") : ""
        const inner = (
          <span className="block space-y-0.5">
            <span className="block text-sm leading-snug text-foreground line-clamp-2">
              {i.title}
            </span>
            <span className="block text-[10px] text-muted-foreground tabular-nums">
              {i.source?.name ?? "Unknown"}
              {date ? ` · ${date}` : ""}
              {Number.isFinite(i.impact_score) ? ` · impact ${i.impact_score.toFixed(1)}` : ""}
            </span>
          </span>
        )
        return (
          <li key={i.id}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(i)}
                className="group block w-full rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/30"
              >
                {inner}
              </button>
            ) : (
              <a
                href={i.url}
                target="_blank"
                rel="noreferrer"
                className="group flex items-start justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-muted/30"
              >
                {inner}
                <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </a>
            )}
          </li>
        )
      })}
    </ul>
  )
}
