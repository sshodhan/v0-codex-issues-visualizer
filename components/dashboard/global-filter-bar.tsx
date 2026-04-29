"use client"

import { CalendarDays, Filter, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState } from "react"

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
  const [isTopicExpanded, setIsTopicExpanded] = useState(false)
  
  // Find currently selected category label
  const selectedCategoryLabel = categoryOptions.find(
    (opt) => opt.value === categoryValue
  )?.label || "All"

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
      {/* Mobile: Compact single-row filters */}
      <div className="sm:hidden flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2 py-1.5">
        {/* Time pills */}
        <div className="flex items-center gap-1">
          <CalendarDays className="h-3 w-3 text-muted-foreground shrink-0" />
          <div className="flex gap-0.5">
            {TIME_OPTIONS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={timeDays === d ? "default" : "ghost"}
                onClick={() => onTimeChange(d)}
                className={`h-6 px-1.5 text-[10px] ${
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
        <div className="h-4 w-px bg-border" />
        {/* Topic dropdown */}
        <div className="flex items-center gap-1">
          <Filter className="h-3 w-3 text-muted-foreground shrink-0" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setIsTopicExpanded(!isTopicExpanded)}
            className="h-6 px-1.5 text-[10px] gap-0.5"
          >
            <span className="truncate max-w-[60px]">{categoryValue === "all" ? "All" : selectedCategoryLabel}</span>
            <ChevronDown className={`h-2.5 w-2.5 transition-transform ${isTopicExpanded ? "rotate-180" : ""}`} />
          </Button>
        </div>
      </div>
      
      {/* Mobile: Expanded topic options */}
      {isTopicExpanded && (
        <div className="sm:hidden flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 px-2 py-1.5">
          {categoryOptions.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={categoryValue === option.value ? "default" : "ghost"}
              onClick={() => {
                onCategoryChange(option.value)
                setIsTopicExpanded(false)
              }}
              className={`h-6 px-2 text-[10px] whitespace-nowrap ${
                categoryValue === option.value 
                  ? "" 
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {option.value === "all" ? "All" : option.label}
            </Button>
          ))}
        </div>
      )}

      {/* Desktop: Time Range Filter Box */}
      <div className="hidden sm:block rounded-lg border border-border bg-muted/30 px-4 py-3">
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

      {/* Desktop: Topic Filter Box */}
      <div className="hidden sm:block flex-1 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Topic
            </span>
            <div className="h-4 w-px bg-border" />
          </div>
          <div className="flex gap-1 flex-wrap">
            {categoryOptions.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={categoryValue === option.value ? "default" : "ghost"}
                onClick={() => onCategoryChange(option.value)}
                className={`h-7 px-2.5 text-xs whitespace-nowrap ${
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
