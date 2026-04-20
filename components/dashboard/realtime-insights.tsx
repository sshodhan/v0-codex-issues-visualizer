"use client"

import { ArrowDownRight, ArrowUpRight, Zap } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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

interface RealtimeInsightsProps {
  insights: RealtimeInsight[]
}

export function RealtimeInsights({ insights }: RealtimeInsightsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-500" />
          What engineers should fix now
        </CardTitle>
        <CardDescription>
          Ranked from the last 72 hours by urgency (volume + momentum + impact + negative sentiment).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {insights.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hot signals detected in the last 72 hours.</p>
        ) : (
          insights.map((insight, index) => {
            const isRising = insight.momentum >= 0
            return (
              <div
                key={insight.category.slug}
                className="rounded-lg border border-border p-4"
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">#{index + 1}</Badge>
                  <Badge
                    className="text-white"
                    style={{ backgroundColor: insight.category.color }}
                  >
                    {insight.category.name}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      isRising ? "text-emerald-600" : "text-rose-600"
                    )}
                  >
                    {isRising ? (
                      <ArrowUpRight className="h-3 w-3" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3" />
                    )}
                    {isRising ? "+" : ""}
                    {insight.momentum} vs prior 72h
                  </Badge>
                  <Badge variant="outline">Urgency {insight.urgencyScore}</Badge>
                </div>

                <div className="mb-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-5">
                  <p><span className="font-medium text-foreground">Now:</span> {insight.nowCount}</p>
                  <p><span className="font-medium text-foreground">Previous:</span> {insight.previousCount}</p>
                  <p><span className="font-medium text-foreground">Avg impact:</span> {insight.avgImpact}</p>
                  <p><span className="font-medium text-foreground">Negative:</span> {insight.negativeRatio}%</p>
                  <p><span className="font-medium text-foreground">Sources:</span> {insight.sourceDiversity}</p>
                </div>

                <div className="space-y-1.5">
                  {insight.topIssues.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No sample issues available.</p>
                  ) : (
                    insight.topIssues.map((issue) => (
                      <p key={issue.id} className="text-sm">
                        <span className="font-medium">[{issue.source}]</span>{" "}
                        {issue.url ? (
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            {issue.title}
                          </a>
                        ) : (
                          <span>{issue.title}</span>
                        )}
                      </p>
                    ))
                  )}
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
