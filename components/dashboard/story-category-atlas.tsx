"use client"

import { useId, useMemo } from "react"
import {
  countBubbles,
  formatLlmCategorySlug,
  heuristicNameToSlug,
  llmColorForName,
  readableTextColor,
  type CountBubble,
} from "@/lib/dashboard/story-category-atlas-layout"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, MousePointer2, Sparkles, Tag } from "lucide-react"

const HEU_MAX = 12
const LLM_MAX = 14

type HeuRow = { name: string; count: number; color: string }
type LlmRow = { name: string; count: number }

type HeuBubble = CountBubble & { color?: string }
type LlmBubble = CountBubble & { rawSlug: string }

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

function prepLlm(rows: LlmRow[]): LlmBubble[] {
  const top = rows.slice(0, LLM_MAX)
  const rest = rows.slice(LLM_MAX)
  const other = rest.reduce((s, r) => s + r.count, 0)
  const out: LlmBubble[] = top.map((r) => ({
    id: `l:${r.name}`,
    label: r.name.replace(/[-_]/g, " "),
    count: r.count,
    sublabel: "LLM",
    rawSlug: r.name,
  }))
  if (other > 0) {
    out.push({
      id: "l:other",
      label: "Other (combined)",
      count: other,
      sublabel: `${rest.length} smaller labels`,
      rawSlug: "__other__",
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

function BubbleField({
  kind,
  items,
  onPick,
  activeId,
}: {
  kind: "heuristic" | "llm"
  items: (HeuBubble | LlmBubble)[]
  onPick: (id: string) => void
  activeId: string | null
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

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border/60 bg-gradient-to-b from-muted/10 to-card">
      <svg
        viewBox={`0 0 ${GW} ${GH}`}
        className="h-[min(42vh,320px)] w-full touch-manipulation"
        role="img"
        aria-label={kind === "heuristic" ? "Topic sizes (heuristic)" : "LLM category sizes"}
      >
        <defs>
          <filter id={`${baseId}-shadow`} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0.6" stdDeviation="0.8" floodOpacity="0.18" />
          </filter>
        </defs>
        {placed.map((b) => {
          const isActive = activeId === b.id
          const isHeu = kind === "heuristic"
          const heuColor = (b as HeuBubble).color
          const llmSlug = (b as LlmBubble).rawSlug
          const baseColor = isHeu
            ? heuColor ?? HEU_FALLBACK
            : llmColorForName(llmSlug || b.label)
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
      </svg>
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
}: StoryCategoryAtlasProps) {
  const heuBubbles = useMemo(() => prepHeuristic(heuristicRows), [heuristicRows])
  const llmBubbles = useMemo(() => prepLlm(llmRows), [llmRows])

  const heuActiveId = useMemo(() => {
    if (selectedHeuristicSlug === "all") return null
    return heuBubbles.find((b) => b.id === `h:${selectedHeuristicSlug}`)?.id ?? null
  }, [selectedHeuristicSlug, heuBubbles])

  const llmActiveId = useMemo(() => {
    if (!selectedLlmCategorySlug || selectedLlmCategorySlug === "all") return null
    const s = formatLlmCategorySlug(selectedLlmCategorySlug)
    return (llmBubbles as LlmBubble[]).find((b) => b.rawSlug === s)?.id ?? null
  }, [selectedLlmCategorySlug, llmBubbles])

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

  const onLlmPick = (id: string) => {
    const b = (llmBubbles as LlmBubble[]).find((x) => x.id === id)
    if (!b) return
    if (b.rawSlug === "__other__" || id === "l:other") {
      onOpenLlmInTriage("all")
      return
    }
    const slug = formatLlmCategorySlug(b.rawSlug)
    if (onExploreBubble) {
      onExploreBubble({ kind: "llm", slug, label: b.label })
    } else {
      onOpenLlmInTriage(slug)
    }
  }

  return (
    <section className="space-y-6 scroll-mt-8" id="story-category-atlas">
      <div className="space-y-2 border-b border-border/50 pb-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">The atlas</p>
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
          Bigger circles = more observations in the selected scope. Click a circle to set the global topic focus (same
          as the filter bar) — it updates the whole page, including the signal cloud and dashboard charts.
        </p>
        <BubbleField
          kind="heuristic"
          items={heuBubbles}
          onPick={onHeuPick}
          activeId={heuActiveId}
        />
        <p className="text-xs text-muted-foreground">
          Drag the <strong>Topic focus</strong> slider above, or use a bubble here, to match the main dashboard&rsquo;s
          heuristic filter.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h4 className="font-serif text-lg font-semibold">LLM categories (classifier)</h4>
        </div>
        <p className="text-sm text-muted-foreground">
          These are <strong>not</strong> the same names as the heuristic list — the classifier uses its own enum. Counts
          include only observations with <code className="rounded bg-muted px-1">llm_classified_at</code> on the
          read model. Click a circle to open the Classifications tab scoped to that LLM category; use triage there for
          subcategory and cluster drill-down.
        </p>
        {llmRows.length === 0 && llmClassifiedInWindow === 0 ? (
          <p className="text-sm border border-dashed rounded-lg p-4 text-muted-foreground">
            No LLM category breakdown in this window — classification may still be running, or the sample is empty.
          </p>
        ) : (
          <BubbleField kind="llm" items={llmBubbles} onPick={onLlmPick} activeId={llmActiveId} />
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
