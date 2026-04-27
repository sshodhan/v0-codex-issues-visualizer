"use client"

import { CalendarDays, Filter } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

const TIME_OPTIONS = [7, 14, 30, 0]

const getTimeLabel = (days: number) => {
  if (days === 0) return "All time"
  return `Last ${days} days`
}

interface CategoryOption {
  value: string
  label: string
  count: number
}

interface GlobalFilterBarProps {
  timeDays: number
  onTimeChange: (days: number) => void
  categoryOptions: CategoryOption[]
  categoryValue: string
  onCategoryChange: (value: string) => void
}

export function GlobalFilterBar({
  timeDays,
  onTimeChange,
  categoryOptions,
  categoryValue,
  onCategoryChange,
}: GlobalFilterBarProps) {
  return (
    <Card className="border-border/80 bg-card/60 backdrop-blur">
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Time range filter */}
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-primary" />
          <span className="text-sm text-muted-foreground">Time:</span>
          <div className="flex gap-1">
            {TIME_OPTIONS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={timeDays === d ? "default" : "outline"}
                onClick={() => onTimeChange(d)}
                className="h-7 px-2.5 text-xs"
              >
                {d === 0 ? "All" : `${d}d`}
              </Button>
            ))}
          </div>
        </div>

        {/*
          "Topic" is the user-facing name for the heuristic regex bucket
          (Bug, Feature Request, Performance, …). Backed by the `categories`
          SQL table and `categorizeIssue` in lib/scrapers/shared.ts —
          deliberately disjoint from the LLM `category` enum surfaced
          elsewhere as "LLM category". See docs/ARCHITECTURE.md §6.0.
          Code identifiers (`categoryOptions`, `categoryValue`,
          `onCategoryChange`) are kept as-is to avoid a churn-only rename.
        */}
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-primary" />
          <span className="text-sm text-muted-foreground">Topic:</span>
          <div className="flex flex-wrap gap-1">
            {categoryOptions.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={categoryValue === option.value ? "default" : "outline"}
                onClick={() => onCategoryChange(option.value)}
                className="h-7 px-2.5 text-xs"
              >
                {option.value === "all" ? "All" : option.label}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
