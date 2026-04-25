"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ExternalLink } from "lucide-react"

interface CategoryData {
  name: string
  slug: string
  color: string
  riskScore: number
  reportCount: number
  positive: number
  neutral: number
  negative: number
  avgImpact: number
}

interface IssueData {
  id: string
  title: string
  url: string | null
  source: string
  impact_score: number
  sentiment: string
  published_at: string
}

interface MergedViewOptionBProps {
  categories: CategoryData[]
  issuesByCategory: Record<string, IssueData[]>
  maxIssuesPerCategory?: number
}

function SentimentBar({
  positive,
  neutral,
  negative,
}: {
  positive: number
  neutral: number
  negative: number
}) {
  const total = positive + neutral + negative
  if (total === 0) return null

  const posPercent = (positive / total) * 100
  const neutralPercent = (neutral / total) * 100
  const negPercent = (negative / total) * 100

  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full">
      <div
        className="bg-[var(--positive)]"
        style={{ width: `${posPercent}%` }}
      />
      <div
        className="bg-[var(--neutral)]"
        style={{ width: `${neutralPercent}%` }}
      />
      <div
        className="bg-[var(--negative)]"
        style={{ width: `${negPercent}%` }}
      />
    </div>
  )
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 0) return `${diffDays}d ago`
  if (diffHours > 0) return `${diffHours}h ago`
  return "Just now"
}

function CategoryCard({
  category,
  issues,
  maxIssues,
}: {
  category: CategoryData
  issues: IssueData[]
  maxIssues: number
}) {
  const total = category.positive + category.neutral + category.negative
  const negativePercent = total > 0 ? Math.round((category.negative / total) * 100) : 0
  const displayIssues = issues.slice(0, maxIssues)

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card">
      {/* Category Header */}
      <div className="border-b border-border p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold text-foreground">{category.name}</h3>
          <span className="text-xs text-muted-foreground">
            Risk {category.riskScore.toFixed(2)} · {category.reportCount} reports
          </span>
        </div>

        <SentimentBar
          positive={category.positive}
          neutral={category.neutral}
          negative={category.negative}
        />

        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{negativePercent}% negative</span>
          <span>·</span>
          <span>avg impact {category.avgImpact.toFixed(2)}</span>
        </div>
      </div>

      {/* Issues List */}
      <div className="flex-1 p-4">
        {displayIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No issues found.</p>
        ) : (
          <div className="space-y-3">
            {displayIssues.map((issue) => (
              <div key={issue.id} className="group">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 text-xs text-[var(--negative)]">●</span>
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
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>Impact {issue.impact_score}</span>
                      <span>·</span>
                      <span>{issue.source}</span>
                      <span>·</span>
                      <span>{formatTimeAgo(issue.published_at)}</span>
                    </div>
                  </div>
                  {issue.url && (
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      {category.reportCount > maxIssues && (
        <div className="border-t border-border px-4 py-2">
          <button className="text-xs font-medium text-primary hover:underline">
            View all {category.reportCount} →
          </button>
        </div>
      )}
    </div>
  )
}

export function MergedViewOptionB({
  categories,
  issuesByCategory,
  maxIssuesPerCategory = 2,
}: MergedViewOptionBProps) {
  // Take top 6 categories for the grid
  const displayCategories = categories.slice(0, 6)

  return (
    <Card>
      <CardHeader className="border-b border-border pb-4">
        <Badge variant="outline" className="mb-2 w-fit text-xs font-medium">
          Option B
        </Badge>
        <CardTitle className="text-lg">What Engineers Should Fix Now</CardTitle>
        <CardDescription>
          Interleaved 2-column grid: All categories and their top issues visible at once
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4">
        {/* 2-Column Responsive Grid */}
        <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2">
          {displayCategories.map((category) => (
            <CategoryCard
              key={category.slug}
              category={category}
              issues={issuesByCategory[category.slug] || []}
              maxIssues={maxIssuesPerCategory}
            />
          ))}
        </div>

        {/* Legend */}
        <div className="mt-4 flex items-center gap-4 border-t border-border pt-4 text-xs text-muted-foreground">
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
