"use client"

import { useId, useMemo, useState } from "react"
import {
  countBubbles,
  heuristicNameToSlug,
  readableTextColor,
  type CountBubble,
} from "@/lib/dashboard/story-category-atlas-layout"
import { pickAtlasAnnotation } from "@/lib/dashboard/atlas-annotation"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, MousePointer2, Sparkles, Tag, X } from "lucide-react"
import { LlmCategoryBars } from "@/components/dashboard/llm-category-bars"

const HEU_MAX = 12

type HeuRow = { name: string; count: number; color: string }
type LlmRow = { name: string; count: number }

type HeuBubble = CountBubble & { color?: string }

function prepHeuristic(rows: HeuRow[]): HeuBubble[] {
  const top = rows.slice(0, HEU_MAX)
  const rest = rows.slice(HEU_MAX)
  const other = rest.reduce((s, r) => s + r.count, 0)
  const out: HeuBubble[] = top.map((r) => ({
    id: `h:${heuristicNameToSlug(r.name)}`,
    label: r.name,
    count: r.count,
    sublabel: "Heuristic",
    color: r.color,
  }))
  if (other > 0) {
    out.push({
      id: "h:other",
      label: "Other (combined)",
      count: other,
      sublabel: `${rest.length} smaller buckets`,
    })
  }
  return out
}

export type AtlasBubbleTarget =
  | { kind: "heuristic"; slug: string; label: string; color?: string }
  | { kind: "llm"; slug: string; label: string; color?: string }

interface StoryCategoryAtlasProps {
  globalTimeLabel: string
  globalCategoryLabel: string
  totalIssues: number
  heuristicRows: HeuRow[]
  llmRows: LlmRow[]
  llmClassifiedInWindow: number
  llmPendingInWindow: number
  onSelectHeuristicSlug: (slug: string) => void
  onOpenLlmInTriage: (llmCategorySlug: string) => void
  onOpenDashboard: () => void
  /**
   * Preferred click behavior: open a drawer to preview/explore a bubble.
   * When supplied, bubble clicks call this instead of the legacy commit handlers.
   * The drawer is responsible for committing via onSelectHeuristicSlug / onOpenLlmInTriage.
   */
  onExploreBubble?: (target: AtlasBubbleTarget) => void
  /** Global filter slug e.g. "bug" or "all" */
  selectedHeuristicSlug: string
  selectedLlmCategorySlug: string | null
  /**
   * What the user is currently exploring (drawer-open). When supplied, the matching
   * cloud renders a "Showing: X — Clear ×" strip above it so the unabbreviated label
   * is visible regardless of how the bubble is rendered.
   */
  exploringTarget?: { kind: "heuristic" | "llm"; slug: string; label: string } | null
  onClearExploring?: () => void
}

const GW = 600
const GH = 280
// Reserve margins around the bubble pack so leader-line callouts and their text
// stay inside the SVG viewBox (the wrapper has overflow-hidden).
const INNER_PAD_X = 70
const INNER_PAD_Y = 18
const INNER_W = GW - INNER_PAD_X * 2
const INNER_H = GH - INNER_PAD_Y * 2
const HEU_FALLBACK = "#64748b" // slate-500 — used for "Other (combined)" when no DB color
const CALLOUT_R = 22
const CALLOUT_LABEL_MAX = 16 // chars; full label is preserved in the <title> tooltip

function truncateForRadius(label: string, r: number): string {
  // ~1.6 chars per radius unit at the chosen font size
  const max = Math.max(6, Math.floor(r * 0.55))
  return label.length > max ? `${label.slice(0, Math.max(3, max - 1))}…` : label
}

function truncateCalloutLabel(label: string): string {
  return label.length > CALLOUT_LABEL_MAX
    ? `${label.slice(0, CALLOUT_LABEL_MAX - 1)}…`
    : label
}

/**
 * Renders the heuristic bubble cloud. (LLM categories now render as a horizontal
 * bar list — see `LlmCategoryBars` — because long enum names don't fit inside circles.)
 */
function BubbleField({
  items,
  onPick,
  activeId,
  totalForAnnotation,
}: {
  items: HeuBubble[]
  onPick: (id: string) => void
  activeId: string | null
  /**
   * Total count across the *original* row set (not just `items`, which may have
   * been combined into "Other"). Used to compute the share-of-total for the
   * editorial annotation. When undefined, the annotation reuses the items' sum.
   */
  totalForAnnotation?: number
}) {
  const baseId = useId()
  const placed = useMemo(
    () =>
      countBubbles(items, {
        minR: 14,
        maxR: 46,
        width: INNER_W,
        height: INNER_H,
      }).map((b) => ({ ...b, x: b.x + INNER_PAD_X, y: b.y + INNER_PAD_Y })),
    [items],
  )
  // Center of the inner bubble area — used as the origin for callout leader directions.
  const cx0 = GW / 2
  const cy0 = GH / 2
  const hasSelection = activeId !== null

  // Editorial annotation: pick the bubble worthy of a callout. Suppressed during
  // active selection so the user's exploration isn't fighting an automatic label.
  const annotation = useMemo(() => {
    if (hasSelection) return null
    return pickAtlasAnnotation(
      items
        .filter((b) => !b.id.endsWith(":other"))
        .map((b) => ({ name: b.label, count: b.count, color: b.color })),
    )
  }, [items, hasSelection])
  const annotationBubble = useMemo(() => {
    if (!annotation) return null
    return placed.find((p) => p.label === annotation.label) ?? null
  }, [annotation, placed])

  // Hover preview state. Debounced via a single state slot — rapid mouse movement
  // simply re-targets the float card rather than flashing it.
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const hovered = hoveredId ? placed.find((p) => p.id === hoveredId) : null

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border/60 bg-gradient-to-b from-muted/10 to-card">
      <svg
        viewBox={`0 0 ${GW} ${GH}`}
        className="h-[min(42vh,320px)] w-full touch-manipulation"
        role="img"
        aria-label="Topic sizes (heuristic)"
      >
        <defs>
          <filter id={`${baseId}-shadow`} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0.6" stdDeviation="0.8" floodOpacity="0.18" />
          </filter>
        </defs>
        {placed.map((b) => {
          const isActive = activeId === b.id
          const baseColor = b.color ?? HEU_FALLBACK
          const fillOpacity = isActive ? 1 : hasSelection ? 0.32 : 0.92
          const insideText = readableTextColor(baseColor)
          const labelInside = b.r >= CALLOUT_R
          const useCallout = !labelInside
          const countFontSize = Math.min(12, Math.max(10, b.r / 3.4))
          // Count is always centered inside the bubble. When the label is also
          // inside (big bubbles), nudge the count below center so the label can
          // sit above. dominantBaseline="central" keeps the count visually
          // centered on the y coordinate, regardless of font metrics.
          const countY = labelInside ? b.y + countFontSize * 0.55 + 2 : b.y
          // Direction of leader line for small bubbles: outward from canvas center.
          const dx = b.x - cx0
          const dy = b.y - cy0
          const dist = Math.max(1, Math.hypot(dx, dy))
          const ux = dx / dist
          const uy = dy / dist
          const leadStartX = b.x + ux * b.r
          const leadStartY = b.y + uy * b.r
          const leadEndX = b.x + ux * (b.r + 9)
          const leadEndY = b.y + uy * (b.r + 9)
          const labelAnchor: "start" | "end" | "middle" =
            ux > 0.25 ? "start" : ux < -0.25 ? "end" : "middle"
          const calloutLabelX = leadEndX + (labelAnchor === "start" ? 2 : labelAnchor === "end" ? -2 : 0)
          // Upward leaders need extra clearance so the text baseline doesn't touch the line.
          const calloutLabelY = leadEndY + (uy < -0.4 ? -3 : uy > 0.4 ? 9 : 3)

          return (
            <g
              key={b.id}
              className="cursor-pointer outline-none focus-visible:[&_circle]:stroke-foreground"
              onClick={() => onPick(b.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onPick(b.id)
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`${b.label}: ${b.count}${isActive ? " (selected)" : ""}`}
              onMouseEnter={() => setHoveredId(b.id)}
              onMouseLeave={() =>
                setHoveredId((cur) => (cur === b.id ? null : cur))
              }
              onFocus={() => setHoveredId(b.id)}
              onBlur={() =>
                setHoveredId((cur) => (cur === b.id ? null : cur))
              }
            >
              <title>{`${b.label} — ${b.count}`}</title>
              <circle
                cx={b.x}
                cy={b.y}
                r={b.r}
                fill={baseColor}
                fillOpacity={fillOpacity}
                strokeWidth={isActive ? 2.25 : 1}
                style={{
                  stroke: `color-mix(in oklab, ${baseColor} 55%, #0b0b0b)`,
                  filter: !hasSelection || isActive ? `url(#${baseId}-shadow)` : undefined,
                  transition: "fill-opacity 160ms ease, stroke-width 160ms ease",
                }}
              />
              {labelInside ? (
                <text
                  x={b.x}
                  y={b.y - countFontSize * 0.6}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="pointer-events-none"
                  fill={insideText}
                  fillOpacity={isActive || !hasSelection ? 1 : 0.85}
                  style={{
                    fontSize: Math.min(13, Math.max(10.5, b.r / 3.1)),
                    fontWeight: 600,
                  }}
                >
                  {truncateForRadius(b.label, b.r)}
                </text>
              ) : null}
              <text
                x={b.x}
                y={countY}
                textAnchor="middle"
                dominantBaseline="central"
                className="pointer-events-none"
                fill={insideText}
                fillOpacity={isActive || !hasSelection ? 0.95 : 0.78}
                style={{
                  fontSize: countFontSize,
                  fontWeight: 600,
                }}
              >
                {b.count}
              </text>
              {useCallout ? (
                <>
                  <line
                    x1={leadStartX}
                    y1={leadStartY}
                    x2={leadEndX}
                    y2={leadEndY}
                    stroke="hsl(var(--muted-foreground))"
                    strokeWidth={1}
                    strokeOpacity={isActive || !hasSelection ? 0.85 : 0.35}
                  />
                  <text
                    x={calloutLabelX}
                    y={calloutLabelY}
                    textAnchor={labelAnchor}
                    className="pointer-events-none fill-foreground"
                    style={{ fontSize: 10.5, fontWeight: 600 }}
                  >
                    {truncateCalloutLabel(b.label)}
                  </text>
                </>
              ) : null}
            </g>
          )
        })}

        {/* Editorial annotation: leader-line + serif callout pointing at the dominant
            bubble. Same idea as the timeline's peak-day annotation. */}
        {annotationBubble && annotation && (() => {
          const dx = annotationBubble.x - cx0
          const dy = annotationBubble.y - cy0
          const dist = Math.max(1, Math.hypot(dx, dy))
          const ux = dx / dist
          const uy = dy / dist
          // Push the callout 28px past the bubble edge in the outward direction so
          // it doesn't overlap any neighbours.
          const sx = annotationBubble.x + ux * (annotationBubble.r + 4)
          const sy = annotationBubble.y + uy * (annotationBubble.r + 4)
          const ex = annotationBubble.x + ux * (annotationBubble.r + 28)
          const ey = annotationBubble.y + uy * (annotationBubble.r + 28)
          const anchor: "start" | "end" =
            ex >= GW / 2 ? "start" : "end"
          const labelX = ex + (anchor === "start" ? 4 : -4)
          const sharePct = Math.round(annotation.share * 100)
          return (
            <g aria-hidden>
              <line
                x1={sx}
                y1={sy}
                x2={ex}
                y2={ey}
                stroke="hsl(var(--foreground))"
                strokeOpacity={0.5}
                strokeWidth={1}
              />
              <text
                x={labelX}
                y={ey + 3}
                textAnchor={anchor}
                className="fill-foreground"
                style={{
                  fontSize: 11,
                  fontStyle: "italic",
                  fontFamily: "var(--font-serif, serif)",
                }}
              >
                ↳ {annotation.label} — {sharePct}%
              </text>
            </g>
          )
        })()}
      </svg>

      {/* Hover preview card — positioned in viewBox-percent space so it tracks the
          bubble even as the SVG resizes. pointer-events-none so it never intercepts. */}
      {hovered && (
        <div
          role="presentation"
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm"
          style={{
            left: `${(hovered.x / GW) * 100}%`,
            top: `${(hovered.y / GH) * 100}%`,
            transform: "translate(-50%, calc(-100% - 10px))",
            minWidth: 140,
          }}
        >
          <div className="font-medium text-foreground">{hovered.label}</div>
          <div className="tabular-nums text-muted-foreground">
            {hovered.count} {hovered.count === 1 ? "report" : "reports"}
            {totalForAnnotation && totalForAnnotation > 0
              ? ` · ${Math.round((hovered.count / totalForAnnotation) * 100)}% of total`
              : null}
          </div>
          <div className="mt-1 italic text-muted-foreground">Click to explore</div>
        </div>
      )}
    </div>
  )
}

function SelectionStrip({
  kind,
  label,
  onClear,
}: {
  kind: "heuristic" | "llm"
  label: string
  onClear?: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-between gap-2 rounded-md border border-foreground/15 bg-muted/40 px-3 py-1.5 text-sm"
    >
      <span className="min-w-0 truncate">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Showing
        </span>
        <span className="ml-2 font-medium text-foreground">{label}</span>
        <span className="ml-1.5 text-xs text-muted-foreground">
          ({kind === "heuristic" ? "heuristic" : "classifier"} category)
        </span>
      </span>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label="Clear exploration"
        >
          Clear
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

export function StoryCategoryAtlas({
  globalTimeLabel,
  globalCategoryLabel,
  totalIssues,
  heuristicRows,
  llmRows,
  llmClassifiedInWindow,
  llmPendingInWindow,
  onSelectHeuristicSlug,
  onOpenLlmInTriage,
  onOpenDashboard,
  onExploreBubble,
  selectedHeuristicSlug,
  selectedLlmCategorySlug,
  exploringTarget,
  onClearExploring,
}: StoryCategoryAtlasProps) {
  const heuristicTotal = useMemo(
    () => heuristicRows.reduce((s, r) => s + r.count, 0),
    [heuristicRows],
  )
  const heuBubbles = useMemo(() => prepHeuristic(heuristicRows), [heuristicRows])

  const heuActiveId = useMemo(() => {
    if (selectedHeuristicSlug === "all") return null
    return heuBubbles.find((b) => b.id === `h:${selectedHeuristicSlug}`)?.id ?? null
  }, [selectedHeuristicSlug, heuBubbles])

  const onHeuPick = (id: string) => {
    if (id === "h:other") {
      // "Other (combined)" has no single slug to drill into — keep legacy behaviour.
      onSelectHeuristicSlug("all")
      return
    }
    const slug = id.replace(/^h:/, "")
    const b = heuBubbles.find((x) => x.id === id)
    if (!b) return
    if (onExploreBubble) {
      onExploreBubble({ kind: "heuristic", slug, label: b.label, color: b.color })
    } else {
      onSelectHeuristicSlug(slug)
    }
  }

  return (
    <section className="space-y-6 scroll-mt-8" id="story-category-atlas">
      <div className="space-y-2 border-b border-border/50 pb-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">
          <span className="text-muted-foreground">01</span>
          <span aria-hidden className="mx-2 text-muted-foreground/60">—</span>
          The atlas
        </p>
        <h3 className="text-2xl sm:text-3xl font-serif font-semibold text-foreground text-balance">
          Where the volume lives — two honest lenses
        </h3>
        <p className="text-base text-muted-foreground leading-relaxed max-w-2xl">
          Every count below is from the <strong>same</strong> time window and topic focus as the main dashboard
          ({globalTimeLabel}
          {globalCategoryLabel && globalCategoryLabel !== "All topics" ? ` · ${globalCategoryLabel}` : ""}).
          The top chart uses the scraper&rsquo;s <strong>heuristic</strong> topics (what colors the signal cloud). The
          second uses <strong>LLM</strong> categories joined on each observation in the materialized view — only reports with
          a resolved classification are counted; pending rows are called out, not imputed.
        </p>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{totalIssues}</span> canonical observations in this scope ·
          <span className="font-medium text-foreground"> {llmClassifiedInWindow}</span> with LLM category on the view ·
          <span className="font-medium text-foreground"> {llmPendingInWindow}</span> not yet classified in the pipeline
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Tag className="h-4 w-4 text-primary" />
          {/* "Topics" = heuristic regex buckets. See docs/ARCHITECTURE.md §6.0. */}
          <h4 className="font-serif text-lg font-semibold">Topics (heuristic)</h4>
        </div>
        <p className="text-sm text-muted-foreground">
          Bigger circles = more observations in the selected scope. Click a circle to explore — the
          drawer opens with the breakdown and lets you commit it as the page filter.
        </p>
        {exploringTarget?.kind === "heuristic" && (
          <SelectionStrip
            kind="heuristic"
            label={exploringTarget.label}
            onClear={onClearExploring}
          />
        )}
        <BubbleField
          items={heuBubbles}
          onPick={onHeuPick}
          activeId={heuActiveId}
          totalForAnnotation={heuristicTotal}
        />
        <p className="text-xs text-muted-foreground">
          The page filter at the top can also be set from a bubble — open the drawer first, then
          choose <em>Use as page filter</em>.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h4 className="font-serif text-lg font-semibold">LLM categories (classifier)</h4>
        </div>
        <p className="text-sm text-muted-foreground">
          A different lens on the same window: the classifier&rsquo;s own categories. Counts include
          only reports the classifier has labelled. Click a row to open the detail drawer.
        </p>
        {exploringTarget?.kind === "llm" && (
          <SelectionStrip
            kind="llm"
            label={exploringTarget.label}
            onClear={onClearExploring}
          />
        )}
        {llmRows.length === 0 && llmClassifiedInWindow === 0 ? (
          <p className="text-sm border border-dashed rounded-lg p-4 text-muted-foreground">
            No classifier breakdown in this window — classification may still be running, or the
            sample is empty.
          </p>
        ) : (
          <LlmCategoryBars
            rows={llmRows}
            selectedSlug={selectedLlmCategorySlug}
            onExplore={onExploreBubble}
            onOpenInTriage={onOpenLlmInTriage}
          />
        )}
      </div>

      <Collapsible className="rounded-lg border border-border/60 bg-card/50">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/30">
          <span className="inline-flex items-center gap-2">
            <MousePointer2 className="h-4 w-4" />
            Why two maps?
          </span>
          <ChevronDown className="h-4 w-4 transition-transform data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4 text-sm text-muted-foreground space-y-2">
          <p>
            <strong>Heuristic</strong> tags come from the enrichment pipeline&rsquo;s fast categorization — good for
            high-level product buckets and the same color encoding as the rest of the dashboard.
          </p>
          <p>
            <strong>LLM</strong> tags come from the structured classifier; they&rsquo;re what powers triage and severity.
            A post can be &ldquo;Bug&rdquo; in the first system and a different top-level class in the second — that&rsquo;s
            expected.
          </p>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onOpenDashboard}>
          Open main dashboard
        </Button>
      </div>
    </section>
  )
}
