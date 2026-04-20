"use client"

import { useMemo } from "react"
import { Trophy, TrendingUp } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { Issue } from "@/hooks/use-dashboard-data"

interface CompetitiveMentionsProps {
  issues: Issue[]
}

const COMPETITORS = [
  { label: "Cursor", terms: ["cursor"] },
  { label: "Claude", terms: ["claude"] },
  { label: "GitHub Copilot", terms: ["copilot", "github copilot"] },
  { label: "Windsurf", terms: ["windsurf", "codeium"] },
  { label: "Replit", terms: ["replit"] },
]

export function CompetitiveMentions({ issues }: CompetitiveMentionsProps) {
  const mentions = useMemo(() => {
    const totals = COMPETITORS.map((competitor) => {
      const count = issues.reduce((acc, issue) => {
        const haystack = `${issue.title} ${issue.content}`.toLowerCase()
        const hasMention = competitor.terms.some((term) => haystack.includes(term))
        return hasMention ? acc + 1 : acc
      }, 0)

      return { name: competitor.label, count }
    })

    return totals.filter((item) => item.count > 0).sort((a, b) => b.count - a.count)
  }, [issues])

  const totalMentioned = mentions.reduce((acc, item) => acc + item.count, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-primary" />
          Competitive mentions
        </CardTitle>
        <CardDescription>
          Track which alternatives users mention in scoped issues to prioritize competitive gaps faster.
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
                <Badge key={item.name} variant="secondary" className="text-xs">
                  {item.name}: {item.count}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
