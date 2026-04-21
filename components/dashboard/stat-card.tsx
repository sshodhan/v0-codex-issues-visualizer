"use client"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  contextText?: string
  icon?: React.ReactNode
  trend?: {
    value: number
    label: string
  }
  className?: string
}

export function StatCard({
  title,
  value,
  subtitle,
  contextText,
  icon,
  trend,
  className,
}: StatCardProps) {
  return (
    <Card className={cn("bg-card border-border", className)}>
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold text-foreground">{value}</p>
            {subtitle && (
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            )}
            {contextText && (
              <p className="text-xs text-muted-foreground/90">{contextText}</p>
            )}
            {trend && (
              <p
                className={cn(
                  "text-sm font-medium",
                  trend.value >= 0 ? "text-[var(--positive)]" : "text-[var(--negative)]"
                )}
              >
                {trend.value >= 0 ? "+" : ""}
                {trend.value}% {trend.label}
              </p>
            )}
          </div>
          {icon && (
            <div className="rounded-lg bg-secondary p-3 text-muted-foreground">
              {icon}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
