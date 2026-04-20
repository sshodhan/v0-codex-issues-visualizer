"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface CategoryHeatmapProps {
  data: Array<{ name: string; count: number; color: string }>
}

export function CategoryHeatmap({ data }: CategoryHeatmapProps) {
  const maxCount = Math.max(...data.map((d) => d.count), 1)
  const sortedData = [...data].sort((a, b) => b.count - a.count)

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-foreground">
          Issue Frequency by Category
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-2">
          {sortedData.map((category) => {
            const intensity = category.count / maxCount
            return (
              <div
                key={category.name}
                className={cn(
                  "relative rounded-lg p-4 transition-all hover:scale-105 cursor-pointer",
                  "flex flex-col items-center justify-center text-center"
                )}
                style={{
                  backgroundColor: category.color,
                  opacity: 0.3 + intensity * 0.7,
                }}
              >
                <span className="text-2xl font-bold text-white drop-shadow-md">
                  {category.count}
                </span>
                <span className="text-xs font-medium text-white/90 drop-shadow-sm mt-1">
                  {category.name}
                </span>
              </div>
            )
          })}
        </div>
        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>Less frequent</span>
          <div className="flex gap-1">
            {[0.3, 0.5, 0.7, 0.9].map((opacity) => (
              <div
                key={opacity}
                className="h-3 w-6 rounded"
                style={{
                  backgroundColor: "#3b82f6",
                  opacity,
                }}
              />
            ))}
          </div>
          <span>More frequent</span>
        </div>
      </CardContent>
    </Card>
  )
}
