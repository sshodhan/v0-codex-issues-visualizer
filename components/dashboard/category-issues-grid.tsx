"use client"

import { useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ExternalLink, ArrowUpRight, ArrowDownRight, Zap, ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { logClientEvent } from "@/lib/error-tracking/client-logger"

interface RealtimeInsight {
  category: { name: string; slug: string; color: string }
  nowCount: number
  previousCount: number
  momentum: number
  avgImpact: number
  negativeRatio: number
  sourceDiversity: number
  urgencyScore: number
  topIssues: Array<{
    id: string
    title: string
    url: string | null
    source: string
    impact_score: number
  }>
}

interface CategoryIssuesGridProps {
  insights: RealtimeInsight[]
  skipFirstCategorySlug?: string | null
  maxIssuesPerCategory?: number
  onViewFullList?: (categorySlug: string) => void
  /**
   * Slug of the active topic chip ("all" or "" when no filter). Used to
   * surface an explicit "no observations" banner when the user picked a
   * topic that has no activity in the 72h window — without it, the grid
   * silently shows the same content as the unfiltered view.
   */
  categoryFilter?: string
  /** Display name for `categoryFilter`; falls back to the slug if missing. */
  categoryFilterLabel?: string
}

// Categories with fewer than HOT_THRESHOLD observations in the now-window
// move to the collapsed "Quiet" subgroup so the urgency story stays
// scannable while keeping every active topic reachable.
const HOT_THRESHOLD = 3

function SentimentBar({ negativeRatio }: { negativeRatio: number }) {
  const negative = negativeRatio
  const positive = Math.max(0, 100 - negative * 1.5) // Estimate positive/neutral split
  const neutral = 100 - negative - positive

  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="bg-[var(--positive)]"
        style={{ width: `${positive}%` }}
      />
      <div
        className="bg-[var(--neutral)]"
        style={{ width: `${neutral}%` }}
      />
      <div
        className="bg-[var(--negative)]"
        style={{ width: `${negative}%` }}
      />
    </div>
  )
}

function CategoryCard({
  insight,
  rank,
  maxIssues,
  onViewFullList,
}: {
  insight: RealtimeInsight
  rank: number
  maxIssues: number
  onViewFullList?: (categorySlug: string) => void
}) {
  const isRising = insight.momentum >= 0
  const displayIssues = insight.topIssues.slice(0, maxIssues)

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card transition-colors hover:border-primary/40">
      {/* Category Header */}
      <div className="border-b border-border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-xs">#{rank}</Badge>
          <Badge
            className="text-white"
            style={{ backgroundColor: insight.category.color }}
          >
            {insight.category.name}
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              "text-xs",
              isRising ? "text-[var(--negative)]" : "text-[var(--positive)]"
            )}
          >
            {isRising ? (
              <ArrowUpRight className="mr-0.5 h-3 w-3" />
            ) : (
              <ArrowDownRight className="mr-0.5 h-3 w-3" />
            )}
            {isRising ? "+" : ""}
            {insight.momentum}
          </Badge>
        </div>

        <SentimentBar negativeRatio={insight.negativeRatio} />

        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">{insight.nowCount}</span> now
          </span>
          <span>
            <span className="font-medium text-foreground">{insight.previousCount}</span> prev
          </span>
          <span>
            Avg impact <span className="font-medium text-foreground">{insight.avgImpact}</span>
          </span>
          <span>
            <span className="font-medium text-foreground">{insight.negativeRatio}%</span> negative
          </span>
        </div>
      </div>

      {/* Issues List */}
      <div className="flex-1 p-4">
        {displayIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sample issues available.</p>
        ) : (
          <div className="space-y-3">
            {displayIssues.map((issue) => (
              <div key={issue.id} className="group">
                <div className="flex items-start gap-2">
                  <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                    {issue.impact_score}
                  </span>
                  <div className="flex-1 min-w-0">
                    {issue.url ? (
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noreferrer"
                        className="line-clamp-2 text-sm text-foreground hover:text-primary hover:underline"
                      >
                        {issue.title}
                      </a>
                    ) : (
                      <span className="line-clamp-2 text-sm text-foreground">
                        {issue.title}
                      </span>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {issue.source}
                    </p>
                  </div>
                  {issue.url && (
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
                      aria-label="Open issue in new tab"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {onViewFullList && (
          <button
            onClick={() => onViewFullList(insight.category.slug)}
            className="mt-4 flex w-full items-center justify-center gap-1 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
          >
            View full list
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function Legend() {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-border pt-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[var(--positive)]" />
        Positive
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[var(--neutral)]" />
        Neutral
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[var(--negative)]" />
        Negative
      </span>
    </div>
  )
}

export function CategoryIssuesGrid({
  insights,
  skipFirstCategorySlug,
  maxIssuesPerCategory = 3,
  onViewFullList,
  categoryFilter,
  categoryFilterLabel,
}: CategoryIssuesGridProps) {
  const filterActive = !!categoryFilter && categoryFilter !== "" && categoryFilter !== "all"
  const filterMatch = filterActive
    ? insights.find((i) => i.category.slug === categoryFilter)
    : undefined
  const filterEmpty = filterActive && !filterMatch
  const filterDisplayName = categoryFilterLabel || categoryFilter || ""

  // Breadcrumb for the "user filtered to a topic with no 72h activity"
  // case. Pre-fix, this would have manifested as a silently-empty hero
  // even when the slug had observations the cap had hidden — so the log
  // doubles as a regression alarm: if it fires for a slug that the
  // dashboard's topic chip claims is selectable, the data path between
  // /api/stats and the chip's option list has drifted.
  useEffect(() => {
    if (filterEmpty) {
      logClientEvent("dashboard-hot-themes-filter-empty", {
        category: categoryFilter,
        categoryLabel: categoryFilterLabel ?? null,
        totalActiveCategories: insights.length,
        activeSlugs: insights.map((i) => i.category.slug),
      })
    }
  }, [filterEmpty, categoryFilter, categoryFilterLabel, insights])

  // Filter out the hero category if specified
  const displayed = skipFirstCategorySlug
    ? insights.filter((i) => i.category.slug !== skipFirstCategorySlug)
    : insights

  const hot = displayed.filter((i) => i.nowCount >= HOT_THRESHOLD)
  const quiet = displayed.filter((i) => i.nowCount < HOT_THRESHOLD)

  if (displayed.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Zap className="h-4 w-4 text-amber-500" />
            What Engineers Should Fix Now
          </CardTitle>
          <CardDescription>
            Top topics ranked by urgency with their most impactful issues
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {filterEmpty
              ? `No observations for ${filterDisplayName} in the last 72 hours.`
              : insights.length === 0
                ? "No hot signals detected in the last 72 hours."
                : "No additional themes beyond the lead story."}
          </p>
        </CardContent>
      </Card>
    )
  }

  const renderCard = (insight: RealtimeInsight) => {
    const globalRank = insights.findIndex(
      (i) => i.category.slug === insight.category.slug
    ) + 1
    return (
      <CategoryCard
        key={insight.category.slug}
        insight={insight}
        rank={globalRank}
        maxIssues={maxIssuesPerCategory}
        onViewFullList={onViewFullList}
      />
    )
  }

  // When the filter is active, the lead is the user's choice (not
  // urgency-#1), so we drop the "#1 by urgency" claim from the description.
  const headerTitle = skipFirstCategorySlug
    ? filterActive
      ? "Other topics with activity"
      : "Other Hot Themes"
    : "What Engineers Should Fix Now"
  const headerDescription = skipFirstCategorySlug
    ? filterActive
      ? "Other topics from the last 72 hours, ordered by urgency."
      : "All topics from the last 72 hours. The lead story above is #1 by urgency."
    : "All topics ranked by urgency (volume + momentum + impact + source diversity)"

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Zap className="h-4 w-4 text-amber-500" />
          {headerTitle}
        </CardTitle>
        <CardDescription>{headerDescription}</CardDescription>
      </CardHeader>

      <CardContent className="p-4 pt-0">
        {filterEmpty && (
          <div className="mb-4 rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            No observations for{" "}
            <span className="font-medium text-foreground">{filterDisplayName}</span> in the
            last 72 hours. Showing all other topics with activity below.
          </div>
        )}

        {hot.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No themes with {HOT_THRESHOLD}+ observations in the last 72 hours.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">{hot.map(renderCard)}</div>
        )}

        {quiet.length > 0 && (
          <details className="mt-4 group">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Show {quiet.length} quiet {quiet.length === 1 ? "category" : "categories"}{" "}
              <span className="text-xs text-muted-foreground">
                (fewer than {HOT_THRESHOLD} observations in 72h)
              </span>
            </summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2">{quiet.map(renderCard)}</div>
          </details>
        )}

        <Legend />
      </CardContent>
    </Card>
  )
}
