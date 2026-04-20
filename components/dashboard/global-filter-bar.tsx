"use client"

import { CalendarDays, Layers3 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"

const TIME_OPTIONS = [0, 7, 14, 30, 90, 180]

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
  const timeIndex = Math.max(TIME_OPTIONS.indexOf(timeDays), 0)

  const categoryIndex = Math.max(
    categoryOptions.findIndex((option) => option.value === categoryValue),
    0
  )

  return (
    <Card className="border-border/80 bg-card/60 backdrop-blur">
      <CardContent className="grid gap-4 p-4 md:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <CalendarDays className="h-4 w-4 text-primary" />
              Global time window
            </p>
            <span className="text-xs text-muted-foreground">{getTimeLabel(timeDays)}</span>
          </div>
          <Slider
            value={[timeIndex]}
            min={0}
            max={TIME_OPTIONS.length - 1}
            step={1}
            onValueChange={(value) => onTimeChange(TIME_OPTIONS[value[0]] ?? 0)}
          />
        </div>

        <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <Layers3 className="h-4 w-4 text-primary" />
              Category cluster focus
            </p>
            <span className="text-xs text-muted-foreground">
              {categoryOptions[categoryIndex]?.label ?? "All categories"}
            </span>
          </div>
          <Slider
            value={[categoryIndex]}
            min={0}
            max={Math.max(categoryOptions.length - 1, 0)}
            step={1}
            onValueChange={(value) => {
              const selected = categoryOptions[value[0]]
              if (selected) onCategoryChange(selected.value)
            }}
          />
          <p className="text-xs text-muted-foreground">
            {categoryOptions[categoryIndex]?.count ?? 0} issues in selected cluster
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
