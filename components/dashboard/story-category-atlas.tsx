"use client"

import { useId, useMemo, useState } from "react"
import {
  countBubbles,
  formatLlmCategorySlug,
  heuristicNameToSlug,
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
    label: r.name.replace(/-/g, " "),
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
  /** Global filter slug e.g. "bug" or "all" */
  selectedHeuristicSlug: string
  selectedLlmCategorySlug: string | null
}

const GW = 520
const GH = 300

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
    () => countBubbles(items, { minR: 16, maxR: 50, width: GW, height: GH }),
    [items],
  )
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border/50 bg-gradient-to-b from-secondary/15 to-card/80">
      <svg
        viewBox={`0 0 ${GW} ${GH}`}
        className="h-[min(38vh,280px)] w-full touch-manipulation"
        role="img"
        aria-label={kind === "heuristic" ? "Heuristic category sizes" : "LLM category sizes"}
      >
        <defs>
          <filter id={`${baseId}-g`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {placed.map((b) => {
          const isActive = activeId === b.id
          const isHeu = kind === "heuristic"
          const heu = b as HeuBubble & { x: number; y: number; r: number }
          const fill =
            isHeu && heu.color
              ? heu.color
              : isHeu
                ? isActive
                  ? "hsl(var(--primary))"
                  : "hsl(var(--primary) / 0.4)"
                : isActive
                  ? "hsl(var(--chart-2))"
                  : "hsl(var(--chart-2) / 0.45)"
          return (
            <g
              key={b.id}
              className="cursor-pointer"
              onClick={() => onPick(b.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onPick(b.id)
                }
              }}
              style={{ filter: isActive ? `url(#${baseId}-g)` : undefined }}
              role="button"
              tabIndex={0}
            >
              <circle
                cx={b.x}
                cy={b.y}
                r={b.r}
                fill={fill}
                stroke="hsl(var(--border))"
                strokeWidth={isActive ? 2 : 1}
                className="transition-opacity hover:opacity-90"
              />
              <text
                x={b.x}
                y={b.y - 5}
                textAnchor="middle"
                className="pointer-events-none"
                fill="white"
                stroke="rgba(0,0,0,0.5)"
                strokeWidth={0.35}
                paintOrder="stroke fill"
                style={{ fontSize: Math.max(7, Math.min(12, b.r / 2.1)) }}
              >
                {b.label.length > 16 ? `${b.label.slice(0, 14)}…` : b.label}
              </text>
              <text
                x={b.x}
                y={b.y + 8}
                textAnchor="middle"
                className="pointer-events-none"
                fill="white"
                stroke="rgba(0,0,0,0.5)"
                strokeWidth={0.35}
                paintOrder="stroke fill"
                style={{ fontSize: Math.max(7, Math.min(11, b.r / 2.4)) }}
              >
                {b.count}
              </text>
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
    if (id === "h:other") onSelectHeuristicSlug("all")
    else onSelectHeuristicSlug(id.replace(/^h:/, ""))
  }

  const onLlmPick = (id: string) => {
    const b = (llmBubbles as LlmBubble[]).find((x) => x.id === id)
    if (!b) return
    if (b.rawSlug === "__other__" || id === "l:other") onOpenLlmInTriage("all")
    else onOpenLlmInTriage(formatLlmCategorySlug(b.rawSlug))
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
