"use client"

import { CalendarDays, Filter } from "lucide-react"
import { Button } from "@/components/ui/button"

const TIME_OPTIONS = [7, 14, 30, 0]

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
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      {/* Time Range Filter Box */}
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Time
            </span>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex gap-1">
            {TIME_OPTIONS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={timeDays === d ? "default" : "ghost"}
                onClick={() => onTimeChange(d)}
                className={`h-7 px-2.5 text-xs ${
                  timeDays === d 
                    ? "" 
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                {d === 0 ? "All" : `${d}d`}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Topic Filter Box */}
      <div className="flex-1 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="flex items-center gap-2 pt-0.5">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Topic
            </span>
          </div>
          <div className="h-4 w-px bg-border mt-0.5" />
          <div className="flex flex-wrap gap-1">
            {categoryOptions.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={categoryValue === option.value ? "default" : "ghost"}
                onClick={() => onCategoryChange(option.value)}
                className={`h-7 px-2.5 text-xs ${
                  categoryValue === option.value 
                    ? "" 
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                {option.value === "all" ? "All" : option.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
