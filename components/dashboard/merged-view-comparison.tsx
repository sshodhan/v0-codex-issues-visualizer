"use client"

import { useMemo } from "react"
import { MergedViewOptionA } from "./merged-view-option-a"
import { MergedViewOptionB } from "./merged-view-option-b"
import type { DashboardStats, Issue } from "@/hooks/use-dashboard-data"

interface MergedViewComparisonProps {
  stats: DashboardStats | undefined
  issues: Issue[]
  isLoading?: boolean
}

export function MergedViewComparison({
  stats,
  issues,
  isLoading,
}: MergedViewComparisonProps) {
  // Transform stats.categorySentimentBreakdown into the format needed by both options
  const categories = useMemo(() => {
    if (!stats?.categorySentimentBreakdown) return []

    return stats.categorySentimentBreakdown
      .map((cat) => {
        const total = cat.positive + cat.neutral + cat.negative
        const negativeShare = total > 0 ? cat.negative / total : 0
        // Risk score formula: negative share × average impact × ln(total + 1)
        const riskScore = negativeShare * cat.avgImpact * Math.log(total + 1)

        return {
          name: cat.name,
          slug: cat.name.toLowerCase().replace(/\s+/g, "-"),
          color: cat.color,
          riskScore,
          reportCount: cat.total,
          positive: cat.positive,
          neutral: cat.neutral,
          negative: cat.negative,
          avgImpact: cat.avgImpact,
        }
      })
      .sort((a, b) => b.riskScore - a.riskScore)
  }, [stats?.categorySentimentBreakdown])

  // Group issues by category slug
  const issuesByCategory = useMemo(() => {
    const grouped: Record<
      string,
      Array<{
        id: string
        title: string
        url: string | null
        source: string
        impact_score: number
        sentiment: string
        published_at: string
      }>
    > = {}

    for (const issue of issues) {
      const categorySlug = issue.category?.name
        ? issue.category.name.toLowerCase().replace(/\s+/g, "-")
        : "uncategorized"

      if (!grouped[categorySlug]) {
        grouped[categorySlug] = []
      }

      grouped[categorySlug].push({
        id: issue.id,
        title: issue.title,
        url: issue.url || null,
        source: issue.source?.name || "Unknown",
        impact_score: issue.impact_score,
        sentiment: issue.sentiment,
        published_at: issue.published_at,
      })
    }

    // Sort each category's issues by impact score (descending)
    for (const slug of Object.keys(grouped)) {
      grouped[slug].sort((a, b) => b.impact_score - a.impact_score)
    }

    return grouped
  }, [issues])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (categories.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">No category data available.</p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">
          Layout Comparison: Merged Category + Issues View
        </h2>
        <p className="text-sm text-muted-foreground">
          Compare two layout options for combining category risk metrics with their top issues.
          Both use live data from your dashboard.
        </p>
      </div>

      {/* Option A: Left/Right Drill-Down */}
      <MergedViewOptionA
        categories={categories}
        issuesByCategory={issuesByCategory}
      />

      {/* Option B: Interleaved 2-Column Grid */}
      <MergedViewOptionB
        categories={categories}
        issuesByCategory={issuesByCategory}
        maxIssuesPerCategory={2}
      />
    </div>
  )
}
