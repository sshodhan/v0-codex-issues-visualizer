"use client"

import { ArrowRight, BrainCircuit } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LlmCategoryBars, type LlmRow } from "@/components/dashboard/llm-category-bars"

interface ClassificationOverviewCardProps {
  rows: LlmRow[]
  classifiedCount: number
  pendingCount: number
  selectedSlug?: string | null
  onOpenClassifications: () => void
  onOpenLlmCategory: (llmCategorySlug: string) => void
}

function pct(part: number, total: number) {
  if (total <= 0) return 0
  return Math.round((part / total) * 100)
}

/**
 * Dashboard-facing summary for the LLM classification layer.
 * The detailed reviewer workflow still lives in the Classifications tab, but
 * this card keeps coverage and category distribution visible in the default
 * dashboard view so users don't have to know to switch tabs first.
 */
export function ClassificationOverviewCard({
  rows,
  classifiedCount,
  pendingCount,
  selectedSlug,
  onOpenClassifications,
  onOpenLlmCategory,
}: ClassificationOverviewCardProps) {
  const total = classifiedCount + pendingCount
  const classifiedPct = pct(classifiedCount, total)
  const pendingPct = pct(pendingCount, total)

  return (
    <Card className="border-primary/20 bg-gradient-to-b from-primary/5 to-card">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg sm:text-xl">
              <BrainCircuit className="h-5 w-5 text-primary" />
              AI classification layer
            </CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              LLM categories sit alongside the heuristic topic filter. Use this view to see how much
              of the current window has been classified, then jump into the reviewer queue by category.
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onOpenClassifications} className="gap-2">
            Open queue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border bg-card/70 p-3">
            <p className="text-xs text-muted-foreground">Classified in view</p>
            <p className="text-2xl font-semibold tabular-nums">{classifiedCount}</p>
            <Badge variant="secondary" className="mt-1">{classifiedPct}% coverage</Badge>
          </div>
          <div className="rounded-md border bg-card/70 p-3">
            <p className="text-xs text-muted-foreground">Awaiting classifier</p>
            <p className="text-2xl font-semibold tabular-nums">{pendingCount}</p>
            <Badge variant={pendingCount > 0 ? "outline" : "secondary"} className="mt-1">
              {pendingPct}% pending
            </Badge>
          </div>
          <div className="rounded-md border bg-card/70 p-3">
            <p className="text-xs text-muted-foreground">LLM categories found</p>
            <p className="text-2xl font-semibold tabular-nums">{rows.length}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Click a bar to scope triage.</p>
          </div>
        </div>

        <LlmCategoryBars
          rows={rows}
          selectedSlug={selectedSlug ?? null}
          onOpenInTriage={onOpenLlmCategory}
        />
      </CardContent>
    </Card>
  )
}
