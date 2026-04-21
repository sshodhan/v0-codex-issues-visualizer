"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ExternalLink } from "lucide-react"

interface CategoryHeatmapProps {
  data: Array<{
    name: string
    color: string
    positive: number
    neutral: number
    negative: number
    total: number
    avgImpact: number
    topIssue: {
      title: string
      url: string | null
      impact_score: number
    } | null
  }>
}

export function CategoryHeatmap({ data }: CategoryHeatmapProps) {
  const sortedData = [...data]
    .map((category) => {
      const negativeShare = category.total > 0 ? category.negative / category.total : 0
      const riskScore = negativeShare * category.avgImpact * Math.log(category.total + 1)
      return {
        ...category,
        riskScore,
        positiveShare: category.total > 0 ? category.positive / category.total : 0,
        neutralShare: category.total > 0 ? category.neutral / category.total : 0,
        negativeShare,
      }
    })
    .sort((a, b) => b.riskScore - a.riskScore)

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-foreground">
          Category Risk + Sentiment Mix
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Ranked by risk score = negative share × average impact × ln(total + 1).
        </p>
        <div className="space-y-3">
          {sortedData.map((category) => {
            return (
              <div key={category.name} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{category.name}</span>
                  <span className="text-xs text-muted-foreground">
                    Risk {category.riskScore.toFixed(2)} • {category.total} reports
                  </span>
                </div>

                <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-emerald-500"
                    style={{ width: `${category.positiveShare * 100}%` }}
                    title={`${category.name}: ${category.positive} positive`}
                  />
                  <div
                    className="h-full bg-slate-500"
                    style={{ width: `${category.neutralShare * 100}%` }}
                    title={`${category.name}: ${category.neutral} neutral`}
                  />
                  <div
                    className="h-full bg-rose-500"
                    style={{ width: `${category.negativeShare * 100}%` }}
                    title={`${category.name}: ${category.negative} negative`}
                  />
                </div>

                <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {Math.round(category.negativeShare * 100)}% negative • avg impact{" "}
                    {category.avgImpact.toFixed(2)}
                  </span>
                  {category.topIssue ? (
                    category.topIssue.url ? (
                      <a
                        href={category.topIssue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        title={category.topIssue.title}
                      >
                        Top issue
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground" title={category.topIssue.title}>
                        Top issue: {category.topIssue.title}
                      </span>
                    )
                  ) : (
                    <span className="text-muted-foreground">No top issue yet</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500" /> Positive
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-slate-500" /> Neutral
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-rose-500" /> Negative
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
