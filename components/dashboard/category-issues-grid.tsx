"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ExternalLink, ArrowUpRight, ArrowDownRight, Zap, ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"

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
}

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

export function CategoryIssuesGrid({
  insights,
  skipFirstCategorySlug,
  maxIssuesPerCategory = 3,
  onViewFullList,
}: CategoryIssuesGridProps) {
  // Filter out the hero category if specified
  const displayed = skipFirstCategorySlug
    ? insights.filter((i) => i.category.slug !== skipFirstCategorySlug)
    : insights

  // Take top 6 categories for the grid
  const displayCategories = displayed.slice(0, 6)

  if (displayCategories.length === 0) {
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
            {insights.length === 0
              ? "No hot signals detected in the last 72 hours."
              : "No additional themes beyond the lead story."}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Zap className="h-4 w-4 text-amber-500" />
          {skipFirstCategorySlug ? "Other Hot Themes" : "What Engineers Should Fix Now"}
        </CardTitle>
        <CardDescription>
          {skipFirstCategorySlug
            ? "More topics from the last 72 hours. The lead story above is #1 by urgency."
            : "Top topics ranked by urgency (volume + momentum + impact + source diversity)"}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 pt-0">
        {/* 2-Column Responsive Grid */}
        <div className="grid gap-4 md:grid-cols-2">
          {displayCategories.map((insight) => {
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
          })}
        </div>

        {/* Legend */}
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
      </CardContent>
    </Card>
  )
}
