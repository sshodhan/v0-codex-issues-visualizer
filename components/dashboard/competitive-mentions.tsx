"use client"

import { Trophy, TrendingUp } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

type MentionItem = {
  competitor: string
  totalMentions: number
  coverage: number
  avgConfidence: number
  netSentiment: number
}

interface CompetitiveMentionsProps {
  mentions: MentionItem[]
}

export function CompetitiveMentions({ mentions }: CompetitiveMentionsProps) {
  const totalMentioned = mentions.reduce((acc, item) => acc + item.totalMentions, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-primary" />
          Competitive mentions
        </CardTitle>
        <CardDescription>
          Mention-level sentiment with confidence and coverage metrics for transparent competitive benchmarking.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {mentions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No competitor mentions in the current issue scope.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Total mention references</span>
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <TrendingUp className="h-4 w-4 text-primary" />
                {totalMentioned}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {mentions.map((item) => (
                <Badge key={item.competitor} variant="secondary" className="text-xs">
                  {item.competitor}: {item.totalMentions} · conf {Math.round(item.avgConfidence * 100)}% · cov {Math.round(item.coverage * 100)}%
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
