"use client"

import { CalendarDays, Filter, X } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

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

        <div className="space-y-3 rounded-lg border border-border/60 bg-secondary/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <Filter className="h-4 w-4 text-primary" />
              Category focus
            </p>
            <span className="text-xs text-muted-foreground">
              {categoryValue === "" ? "All categories" : "Filtering"}
            </span>
          </div>
          
          {/* Selected Category Display */}
          <div className="flex items-center gap-2">
            {categoryValue !== "" ? (
              <>
                <Badge variant="secondary" className="capitalize">
                  {categoryOptions[categoryIndex]?.label ?? "Unknown"}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onCategoryChange("")}
                  className="h-6 w-6 p-0 hover:bg-destructive/20"
                  title="Reset to all categories"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground italic">No category filter applied</span>
            )}
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
            {categoryValue === "" 
              ? "Total issues across all categories" 
              : `${categoryOptions[categoryIndex]?.count ?? 0} issues in ${categoryOptions[categoryIndex]?.label ?? "selected"} category`}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
