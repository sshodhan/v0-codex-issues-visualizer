"use client"

import { Trophy, TrendingUp, CircleHelp } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

type MentionItem = {
  competitor: string
  totalMentions: number
  coverage: number
  avgConfidence: number
  netSentiment: number
}

type MentionsMeta = {
  competitorsTracked: number
  mentionCoverage: number
  avgConfidence: number
  totalScoredMentions?: number
}

interface CompetitiveMentionsProps {
  mentions: MentionItem[]
  meta?: MentionsMeta
}

function pct(value: number | undefined | null): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—"
  return `${Math.round(value * 100)}%`
}

export function CompetitiveMentions({ mentions, meta }: CompetitiveMentionsProps) {
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
            {meta && (
              <TooltipProvider delayDuration={150}>
                <div className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-muted/30 p-2 text-xs">
                  <MetaStat
                    label="Competitors"
                    value={String(meta.competitorsTracked)}
                    hint="Number of tracked competitors with at least one mention in the scope."
                  />
                  <MetaStat
                    label="Coverage"
                    value={pct(meta.mentionCoverage)}
                    hint="Share of raw mentions whose surrounding sentence contained evidence tokens the scorer could use."
                  />
                  <MetaStat
                    label="Confidence"
                    value={pct(meta.avgConfidence)}
                    hint="Mean per-issue confidence across scored mentions, weighted by mention volume."
                  />
                </div>
              </TooltipProvider>
            )}
            <div className="flex flex-wrap gap-2">
              {mentions.map((item) => (
                <Badge key={item.competitor} variant="secondary" className="text-xs">
                  {item.competitor}: {item.totalMentions} · conf {pct(item.avgConfidence)} · cov {pct(item.coverage)}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MetaStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 text-muted-foreground">
        {label}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-3 w-3 items-center justify-center text-muted-foreground/70 hover:text-foreground"
              aria-label={`${label} definition`}
            >
              <CircleHelp className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[220px] text-xs">
            {hint}
          </TooltipContent>
        </Tooltip>
      </span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  )
}
