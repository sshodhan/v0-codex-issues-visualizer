"use client"

import { useMemo } from "react"
import {
  bucketByDay,
  filterByHeuristic,
  sentimentSplit,
  topByImpact,
  topErrorCodes,
  topSources,
} from "@/lib/dashboard/story-drawer-data"
import { useIssues, type Issue } from "@/hooks/use-dashboard-data"
import { Button } from "@/components/ui/button"
import { ArrowRight, Filter } from "lucide-react"
import { DrawerSection } from "./section"
import { Sparkline } from "./sparkline"
import { DistributionBar } from "./distribution-bar"
import { SourceBars } from "./source-bars"
import { IssueList } from "./issue-list"
import type { StoryDrawerTarget } from "./types"

const SENTIMENT_SEGMENTS = [
  { key: "positive", label: "Positive", className: "bg-emerald-500" },
  { key: "neutral", label: "Neutral", className: "bg-muted-foreground/40" },
  { key: "negative", label: "Negative", className: "bg-red-500" },
]

/** Cap on rows fetched from /api/issues for an LLM drawer. */
const LLM_FETCH_LIMIT = 240

interface Props {
  target: Extract<StoryDrawerTarget, { kind: "heuristic" | "llm" }>
  issues: Issue[]
  windowMs: { startMs: number; endMs: number }
  isAlreadyApplied: boolean
  onUseAsFilter: () => void
  onOpenAllInTable: () => void
  onDrillErrorCode: (code: string) => void
  onSelectIssue: (issueId: string) => void
}

export function HeuristicLlmDrawerContent({
  target,
  issues,
  windowMs,
  isAlreadyApplied,
  onUseAsFilter,
  onOpenAllInTable,
  onDrillErrorCode,
  onSelectIssue,
}: Props) {
  // Heuristic side: client-side filter over already-loaded issues. The category
  // slug on each Issue matches the breakdown's source 1:1.
  //
  // LLM side: fetch via /api/issues?llm_category=X. The bar count comes from
  // /api/stats which reads `mv_observation_current.llm_category` — but Issue's
  // `llm_primary_tag` is a *different* field that is not always populated. A
  // client-side filter on `llm_primary_tag` was returning empty even for
  // categories with high bar counts (the "0 reports for tool_invocation_error"
  // bug). The /api/issues endpoint filters on the same `llm_category` source
  // as /api/stats, so the count and the issues returned will always match.
  const isLlm = target.kind === "llm"
  const llmFetch = useIssues({
    enabled: isLlm,
    llm_category: isLlm ? target.slug : undefined,
    sortBy: "impact_score",
    order: "desc",
    limit: LLM_FETCH_LIMIT,
  })

  const heuristicMatched = useMemo(
    () => (isLlm ? [] : filterByHeuristic(issues, target.slug)),
    [isLlm, issues, target.slug],
  )

  // Unified data source: either the heuristic filter (instant, client-side) or
  // the LLM fetch (network, cached by SWR per slug).
  const matched: Issue[] = isLlm ? llmFetch.issues : heuristicMatched
  // For LLM, prefer the API-reported total (uncapped, matches the bar). For
  // heuristic, the matched array IS the full set in the loaded sample.
  const totalCount = isLlm ? llmFetch.count : heuristicMatched.length
  const isLoading = isLlm && llmFetch.isLoading && matched.length === 0

  const sparkline = useMemo(
    () => bucketByDay(matched, windowMs.startMs, windowMs.endMs),
    [matched, windowMs.startMs, windowMs.endMs],
  )
  const sentiment = useMemo(() => sentimentSplit(matched), [matched])
  const sources = useMemo(() => topSources(matched, 5), [matched])
  const errorCodes = useMemo(() => topErrorCodes(matched, 8), [matched])
  const top = useMemo(() => topByImpact(matched, 5), [matched])

  const sentimentSegments = SENTIMENT_SEGMENTS.map((s) => ({
    ...s,
    count:
      s.key === "positive"
        ? sentiment.positive
        : s.key === "negative"
          ? sentiment.negative
          : sentiment.neutral,
  }))

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-1.5 px-4 pt-4 pb-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: target.color ?? "hsl(var(--muted-foreground))" }}
          />
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {target.kind === "heuristic" ? "Heuristic topic" : "LLM category"}
          </p>
        </div>
        <h3 className="font-serif text-2xl font-semibold leading-tight text-foreground text-balance">
          {target.label}
        </h3>
        <p className="text-sm text-muted-foreground tabular-nums">
          {isLoading ? (
            "Loading…"
          ) : (
            <>
              {totalCount} {totalCount === 1 ? "report" : "reports"}
              {isLlm && totalCount > matched.length
                ? ` · showing latest ${matched.length}`
                : ""}
              {" · "}
              {sources.length} {sources.length === 1 ? "source" : "sources"}
            </>
          )}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        <DrawerSection title="Volume over time" caption={`${matched.length} total`}>
          <Sparkline
            data={sparkline}
            color={target.color ?? "hsl(var(--primary))"}
          />
        </DrawerSection>

        {sentiment.total > 0 && (
          <DrawerSection title="Sentiment" caption={`${sentiment.total} classified`}>
            <DistributionBar segments={sentimentSegments} total={sentiment.total} />
          </DrawerSection>
        )}

        {sources.length > 0 && (
          <DrawerSection title="Top sources" caption={`top ${sources.length}`}>
            <SourceBars sources={sources} />
          </DrawerSection>
        )}

        {errorCodes.length > 0 && (
          <DrawerSection
            title="Error patterns inside this topic"
            caption={`${errorCodes.length} distinct`}
          >
            <ul className="flex flex-wrap gap-1.5">
              {errorCodes.map((c) => (
                <li key={c.code}>
                  <button
                    type="button"
                    onClick={() => onDrillErrorCode(c.code)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs transition-colors hover:border-foreground/40 hover:bg-muted/30"
                  >
                    <code className="font-mono text-[11px] text-foreground">{c.code}</code>
                    <span className="tabular-nums text-muted-foreground">{c.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </DrawerSection>
        )}

        <DrawerSection title="Top reports by impact" caption={`top ${top.length}`}>
          <IssueList
            issues={top}
            onSelect={(i) => onSelectIssue(i.id)}
            emptyHint={
              isLoading
                ? "Loading…"
                : "No high-impact reports in this slice."
            }
          />
        </DrawerSection>
      </div>

      <footer className="mt-auto flex flex-col gap-2 border-t border-border/50 bg-card/40 p-4">
        <Button
          type="button"
          onClick={onUseAsFilter}
          disabled={isAlreadyApplied}
          className="w-full justify-center gap-2"
        >
          <Filter className="h-4 w-4" />
          {isAlreadyApplied ? "Already applied" : "Use as page filter"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onOpenAllInTable}
          className="w-full justify-center gap-2"
        >
          Open {totalCount} in table
          <ArrowRight className="h-4 w-4" />
        </Button>
      </footer>
    </div>
  )
}
