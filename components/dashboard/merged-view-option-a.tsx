"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"

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

interface MergedViewOptionAProps {
  categories: CategoryData[]
  issuesByCategory: Record<string, IssueData[]>
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

export function MergedViewOptionA({
  categories,
  issuesByCategory,
}: MergedViewOptionAProps) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(
    categories[0]?.slug || null
  )

  const selectedCategoryData = categories.find((c) => c.slug === selectedCategory)
  const selectedIssues = selectedCategory
    ? issuesByCategory[selectedCategory] || []
    : []

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border pb-4">
        <Badge variant="outline" className="mb-2 w-fit text-xs font-medium">
          Option A
        </Badge>
        <CardTitle className="text-lg">What Engineers Should Fix Now</CardTitle>
        <CardDescription>
          Left/Right drill-down pattern: Select a category to see its issues
        </CardDescription>
      </CardHeader>

      <CardContent className="p-0">
        <div className="flex flex-col lg:flex-row">
          {/* Left Column: Categories */}
          <div className="flex-shrink-0 border-b border-border lg:w-80 lg:border-b-0 lg:border-r">
            <div className="p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Categories
              </h3>
            </div>
            <div className="max-h-[400px] overflow-y-auto lg:max-h-[500px]">
              {categories.map((category) => {
                const isSelected = category.slug === selectedCategory
                const negativePercent =
                  category.positive + category.neutral + category.negative > 0
                    ? Math.round(
                        (category.negative /
                          (category.positive + category.neutral + category.negative)) *
                          100
                      )
                    : 0

                return (
                  <button
                    key={category.slug}
                    onClick={() => setSelectedCategory(category.slug)}
                    className={cn(
                      "w-full border-l-2 px-4 py-3 text-left transition-colors",
                      isSelected
                        ? "border-l-primary bg-secondary/50"
                        : "border-l-transparent hover:bg-secondary/30"
                    )}
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="font-medium text-foreground">
                        {category.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Risk {category.riskScore.toFixed(2)}
                      </span>
                    </div>

                    <SentimentBar
                      positive={category.positive}
                      neutral={category.neutral}
                      negative={category.negative}
                    />

                    <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{category.reportCount} reports</span>
                      <span>·</span>
                      <span>{negativePercent}% negative</span>
                      <span>·</span>
                      <span>avg impact {category.avgImpact.toFixed(2)}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Right Column: Issues */}
          <div className="flex-1">
            <div className="border-b border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Issues in:{" "}
                <span
                  className="text-foreground"
                  style={{ color: selectedCategoryData?.color }}
                >
                  {selectedCategoryData?.name || "None selected"}
                </span>
              </h3>
            </div>

            <div className="max-h-[400px] overflow-y-auto p-4 lg:max-h-[500px]">
              {selectedIssues.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No issues found for this category.
                </p>
              ) : (
                <div className="space-y-3">
                  {selectedIssues.map((issue, index) => (
                    <div
                      key={issue.id}
                      className="rounded-lg border border-border p-3"
                    >
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          {index + 1}.
                        </span>
                        <div className="flex-1">
                          {issue.url ? (
                            <a
                              href={issue.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm font-medium text-foreground hover:text-primary hover:underline"
                            >
                              {issue.title}
                            </a>
                          ) : (
                            <span className="text-sm font-medium text-foreground">
                              {issue.title}
                            </span>
                          )}
                        </div>
                        {issue.url && (
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex-shrink-0 text-muted-foreground hover:text-primary"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Impact {issue.impact_score}</span>
                        <span>·</span>
                        <span>{issue.source}</span>
                        <span>·</span>
                        <span>{formatTimeAgo(issue.published_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {selectedIssues.length > 0 && (
                <div className="mt-4">
                  <button className="text-sm font-medium text-primary hover:underline">
                    View all {selectedCategoryData?.reportCount} issues →
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-xs text-muted-foreground">
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
