"use client"

import { useMemo, useState } from "react"
import {
  formatLlmCategorySlug,
  llmColorForName,
} from "@/lib/dashboard/story-category-atlas-layout"
import { Button } from "@/components/ui/button"
import { ChevronDown } from "lucide-react"
import type { AtlasBubbleTarget } from "./story-category-atlas"

const TOP_VISIBLE = 6

export interface LlmRow {
  name: string
  count: number
}

interface Props {
  rows: LlmRow[]
  /** Currently selected LLM category slug, used to highlight the active row. */
  selectedSlug: string | null
  /** Drawer-aware callback (preferred). When supplied, click opens the drawer. */
  onExplore?: (target: AtlasBubbleTarget) => void
  /** Legacy direct-navigate fallback when no drawer is wired. */
  onOpenInTriage: (llmCategorySlug: string) => void
}

/**
 * Horizontal bar list for LLM categories. Replaces the bubble cloud — long enum names
 * (e.g. `tool_invocation_error`) never fit inside circles, so a sorted bar list reads
 * better and Cleveland-McGill ranks length above area for ordinal comparison anyway.
 *
 * Visual identity is preserved by keeping the same per-name color palette as the bubble
 * version, so cross-referencing with the atlas (heuristic side) stays consistent.
 *
 * Click → drawer (when wired) or legacy triage navigation. Top six visible by default;
 * the rest collapse behind a disclosure so the section stays scannable.
 */
export function LlmCategoryBars({
  rows,
  selectedSlug,
  onExplore,
  onOpenInTriage,
}: Props) {
  const [showAll, setShowAll] = useState(false)
  const sorted = useMemo(() => [...rows].sort((a, b) => b.count - a.count), [rows])
  const max = useMemo(() => Math.max(1, ...sorted.map((r) => r.count)), [sorted])
  const topRows = sorted.slice(0, TOP_VISIBLE)
  const restRows = sorted.slice(TOP_VISIBLE)
  const visible = showAll ? sorted : topRows
  const total = useMemo(() => sorted.reduce((s, r) => s + r.count, 0), [sorted])
  const activeRaw = selectedSlug ? formatLlmCategorySlug(selectedSlug) : null

  if (sorted.length === 0) {
    return (
      <p className="text-sm border border-dashed rounded-lg p-4 text-muted-foreground">
        No LLM category breakdown in this window — classification may still be running, or
        the sample is empty.
      </p>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-gradient-to-b from-muted/10 to-card p-2 sm:p-4">
      <ul className="space-y-1">
        {visible.map((r) => {
          const friendly = r.name.replace(/[-_]/g, " ")
          const color = llmColorForName(r.name)
          const pct = (r.count / max) * 100
          const isActive = activeRaw === r.name.toLowerCase()
          const sharePct = total > 0 ? Math.round((r.count / total) * 100) : 0
          const click = () => {
            if (onExplore) {
              onExplore({ kind: "llm", slug: r.name, label: friendly })
            } else {
              onOpenInTriage(formatLlmCategorySlug(r.name))
            }
          }
          return (
            <li key={r.name}>
              <button
                type="button"
                onClick={click}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    click()
                  }
                }}
                className={`group grid w-full items-center gap-1.5 sm:gap-3 rounded-md px-1.5 sm:px-2 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring grid-cols-[7rem_1fr_2.5rem] sm:grid-cols-[16rem_1fr_3.5rem] ${
                  isActive ? "bg-muted/60 ring-1 ring-border" : ""
                }`}
                aria-label={`${friendly}: ${r.count} reports (${sharePct}% of classified)${
                  isActive ? ", currently selected" : ""
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 sm:h-2.5 sm:w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className="truncate text-xs sm:text-sm text-foreground/90"
                    title={friendly}
                  >
                    {friendly}
                  </span>
                </span>
                <span className="block h-1.5 sm:h-2 rounded-sm bg-muted/40" aria-hidden>
                  <span
                    className="block h-full rounded-sm transition-[width] duration-200"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                  />
                </span>
                <span className="text-right text-[10px] sm:text-sm tabular-nums text-foreground">
                  {r.count}
                  <span className="ml-0.5 sm:ml-1 text-[8px] sm:text-[10px] text-muted-foreground">
                    {sharePct}%
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {restRows.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAll((v) => !v)}
          className="h-8 w-full justify-between gap-2 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={showAll}
        >
          <span>
            {showAll
              ? "Hide smaller categories"
              : `Show ${restRows.length} more categor${restRows.length === 1 ? "y" : "ies"}`}
          </span>
          <ChevronDown
            className={`h-4 w-4 transition-transform ${showAll ? "rotate-180" : ""}`}
          />
        </Button>
      )}
    </div>
  )
}
