"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ExternalLink, X } from "lucide-react"

interface Props {
  /** Human-friendly window label, e.g. "Last 30 days". */
  globalTimeLabel: string
  /** Resolved category label, e.g. "Bug" or "All topics". The bar hides the topic
   *  chip when this is "All topics". */
  categoryLabel: string
  totalCount: number
  asOfActive: boolean
  /**
   * CSS selector for the element whose disappearance from the viewport triggers
   * the bar. Default targets `#story-filters` so the bar appears once the
   * inline filter strip scrolls offscreen.
   */
  triggerSelector?: string
  onClearCategory?: () => void
  onOpenDashboard?: () => void
}

/**
 * A slim sticky strip that pins to the top of the viewport once the user scrolls
 * past the inline filter bar. Keeps the answer to "what window am I looking at?"
 * always one glance away on a long page.
 *
 * Uses IntersectionObserver to track the trigger element — the bar slides in via
 * a CSS transform when the trigger leaves the viewport, and slides out when it
 * comes back. `prefers-reduced-motion` disables the slide.
 */
export function StickyScopeBar({
  globalTimeLabel,
  categoryLabel,
  totalCount,
  asOfActive,
  triggerSelector = "#story-filters",
  onClearCategory,
  onOpenDashboard,
}: Props) {
  const [shown, setShown] = useState(false)
  const triggerRef = useRef<Element | null>(null)

  useEffect(() => {
    const trigger = document.querySelector(triggerSelector)
    triggerRef.current = trigger
    if (!trigger) return

    const obs = new IntersectionObserver(
      ([entry]) => {
        // Bar shown when the trigger is fully out of view (scrolled past).
        setShown(!entry.isIntersecting && entry.boundingClientRect.bottom < 0)
      },
      { threshold: 0, rootMargin: "0px 0px 0px 0px" },
    )
    obs.observe(trigger)
    return () => obs.disconnect()
  }, [triggerSelector])

  const showTopicChip = categoryLabel && categoryLabel !== "All topics"

  return (
    <div
      data-shown={shown}
      role="region"
      aria-label="Story scope"
      className="
        fixed inset-x-0 top-0 z-30 border-b border-border/60
        bg-background/85 backdrop-blur-md
        transition-transform duration-200 ease-out
        data-[shown=false]:-translate-y-full
        motion-reduce:transition-none
      "
    >
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            title={asOfActive ? "Replay mode (data is frozen)" : "Live"}
            className={`h-2 w-2 shrink-0 rounded-full ${
              asOfActive ? "bg-muted-foreground/50" : "bg-emerald-500"
            }`}
          />
          <span className="font-medium text-foreground tabular-nums">
            {globalTimeLabel}
          </span>
          {showTopicChip && (
            <>
              <span aria-hidden className="text-muted-foreground/60">
                ·
              </span>
              <span className="truncate text-foreground">
                <span className="text-muted-foreground">Topic: </span>
                {categoryLabel}
              </span>
              {onClearCategory && (
                <button
                  type="button"
                  onClick={onClearCategory}
                  aria-label="Clear topic filter"
                  className="inline-flex shrink-0 items-center rounded-full p-0.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </>
          )}
          <span
            aria-hidden
            className="hidden text-muted-foreground tabular-nums sm:inline"
          >
            · {totalCount} {totalCount === 1 ? "report" : "reports"}
          </span>
        </div>

        {onOpenDashboard && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onOpenDashboard}
            className="h-7 shrink-0 gap-1 text-xs"
          >
            <span className="hidden sm:inline">Open dashboard</span>
            <span className="sm:hidden">Dashboard</span>
            <ExternalLink className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  )
}
