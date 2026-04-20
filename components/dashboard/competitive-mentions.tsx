"use client"

import { Crosshair, ExternalLink } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface CompetitiveMention {
  competitor: string
  totalMentions: number
  positive: number
  negative: number
  neutral: number
  netSentiment: number
  topIssues: Array<{
    id: string
    title: string
    url: string | null
    sentiment: "positive" | "negative" | "neutral" | null
    impact_score: number
  }>
}

interface CompetitiveMentionsProps {
  mentions: CompetitiveMention[]
}

function netSentimentTone(net: number) {
  if (net > 0.15) return "text-emerald-600 border-emerald-500/40 bg-emerald-500/10"
  if (net < -0.15) return "text-rose-600 border-rose-500/40 bg-rose-500/10"
  return "text-muted-foreground border-border bg-secondary/40"
}

export function CompetitiveMentions({ mentions }: CompetitiveMentionsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Crosshair className="h-4 w-4 text-blue-500" />
          Competitive mentions (last 6 days)
        </CardTitle>
        <CardDescription>
          How often competitors come up alongside Codex in recent feedback, and the
          sentiment of the surrounding conversation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {mentions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No competitor mentions detected in the last 6 days.
          </p>
        ) : (
          mentions.map((mention) => (
            <div key={mention.competitor} className="rounded-lg border border-border p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{mention.competitor}</Badge>
                <Badge variant="outline">{mention.totalMentions} mentions</Badge>
                <Badge
                  variant="outline"
                  className={cn("border", netSentimentTone(mention.netSentiment))}
                >
                  Net sentiment {mention.netSentiment > 0 ? "+" : ""}
                  {mention.netSentiment}
                </Badge>
              </div>

              <div className="mb-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
                <p>
                  <span className="font-medium text-emerald-500">{mention.positive}</span>{" "}
                  positive
                </p>
                <p>
                  <span className="font-medium text-rose-500">{mention.negative}</span>{" "}
                  negative
                </p>
                <p>
                  <span className="font-medium text-foreground">{mention.neutral}</span>{" "}
                  neutral
                </p>
              </div>

              <div className="space-y-1.5">
                {mention.topIssues.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No high-impact sample issues yet.
                  </p>
                ) : (
                  mention.topIssues.map((issue) => (
                    <p key={issue.id} className="text-sm">
                      {issue.url ? (
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1"
                        >
                          {issue.title}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span>{issue.title}</span>
                      )}
                    </p>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
