"use client"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { TrendingUp, TrendingDown, Minus, ArrowRight } from "lucide-react"

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
  insight?: {
    headline: string
    action?: string
    actionHref?: string
  }
  variant?: "default" | "highlight" | "warning" | "success"
  className?: string
}

export function StatCard({
  title,
  value,
  subtitle,
  contextText,
  icon,
  trend,
  insight,
  variant = "default",
  className,
}: StatCardProps) {
  const variantStyles = {
    default: "bg-card border-border",
    highlight: "bg-card border-l-4 border-l-primary border-border",
    warning: "bg-card border-l-4 border-l-[var(--insight-warning)] border-border",
    success: "bg-card border-l-4 border-l-[var(--insight-success)] border-border",
  }

  const TrendIcon = trend?.value === 0 ? Minus : trend?.value && trend.value > 0 ? TrendingUp : TrendingDown

  return (
    <Card className={cn(
      variantStyles[variant],
      "shadow-sm hover:shadow-md transition-shadow duration-200",
      className
    )}>
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5 min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold text-foreground tracking-tight truncate">{value}</p>
            {subtitle && (
              <p className="text-sm text-muted-foreground leading-relaxed">{subtitle}</p>
            )}
            {trend && (
              <div className="flex items-center gap-1.5 mt-1">
                <TrendIcon className={cn(
                  "h-4 w-4",
                  trend.value > 0 ? "text-[var(--negative)]" : trend.value < 0 ? "text-[var(--positive)]" : "text-muted-foreground"
                )} />
                <span
                  className={cn(
                    "text-sm font-medium",
                    trend.value > 0 ? "text-[var(--negative)]" : trend.value < 0 ? "text-[var(--positive)]" : "text-muted-foreground"
                  )}
                >
                  {trend.value > 0 ? "+" : ""}{trend.value}% {trend.label}
                </span>
              </div>
            )}
            {contextText && (
              <p className="text-xs text-muted-foreground/80 mt-1">{contextText}</p>
            )}
          </div>
          {icon && (
            <div className="rounded-lg bg-secondary p-2.5 text-muted-foreground flex-shrink-0">
              {icon}
            </div>
          )}
        </div>
        
        {insight && (
          <div className="mt-4 pt-4 border-t border-border">
            <p className="text-sm font-medium text-foreground">{insight.headline}</p>
            {insight.action && (
              <a 
                href={insight.actionHref || "#"} 
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1.5 font-medium"
              >
                {insight.action}
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// New component for insight-first KPI display
interface InsightKpiCardProps {
  category: string
  headline: string
  metrics: {
    total: number
    negativeShare: number
    avgImpact: number
    momentum?: number
  }
  topIssue?: {
    title: string
    url?: string | null
    source?: string
  }
  variant?: "risk" | "impact" | "trending"
  className?: string
}

export function InsightKpiCard({
  category,
  headline,
  metrics,
  topIssue,
  variant = "risk",
  className,
}: InsightKpiCardProps) {
  const variantStyles = {
    risk: "border-l-4 border-l-[var(--negative)]",
    impact: "border-l-4 border-l-[var(--insight-warning)]",
    trending: "border-l-4 border-l-[var(--insight-info)]",
  }

  const hasMomentum = typeof metrics.momentum === "number"

  return (
    <Card className={cn(
      "bg-card border-border shadow-sm hover:shadow-md transition-shadow duration-200",
      variantStyles[variant],
      className
    )}>
      <CardContent className="p-6">
        <div className="flex flex-col gap-3">
          {/* Category badge */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {variant === "risk" ? "Top Risk" : variant === "impact" ? "Highest Impact" : "Trending"}
            </span>
            {hasMomentum && metrics.momentum !== 0 && (
              <span className={cn(
                "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full",
                metrics.momentum! > 0 
                  ? "bg-[var(--negative)]/10 text-[var(--negative)]" 
                  : "bg-[var(--positive)]/10 text-[var(--positive)]"
              )}>
                {metrics.momentum! > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {metrics.momentum! > 0 ? "+" : ""}{metrics.momentum}%
              </span>
            )}
          </div>
          
          {/* Category name */}
          <h3 className="text-2xl font-bold text-foreground tracking-tight">{category}</h3>
          
          {/* Insight headline */}
          <p className="text-sm text-muted-foreground leading-relaxed">{headline}</p>
          
          {/* Metrics row */}
          <div className="flex flex-wrap gap-4 mt-1">
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">Signals</span>
              <span className="text-sm font-semibold text-foreground">{metrics.total}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">Negative</span>
              <span className="text-sm font-semibold text-foreground">{Math.round(metrics.negativeShare * 100)}%</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">Avg Impact</span>
              <span className="text-sm font-semibold text-foreground">{metrics.avgImpact.toFixed(1)}</span>
            </div>
          </div>
          
          {/* Top issue evidence */}
          {topIssue && (
            <div className="mt-3 pt-3 border-t border-border">
              <p className="text-xs text-muted-foreground mb-1">Representative issue:</p>
              {topIssue.url ? (
                <a 
                  href={topIssue.url} 
                  target="_blank" 
                  rel="noreferrer"
                  className="text-sm text-primary hover:underline line-clamp-2"
                >
                  {topIssue.title}
                </a>
              ) : (
                <p className="text-sm text-foreground line-clamp-2">{topIssue.title}</p>
              )}
              {topIssue.source && (
                <span className="text-xs text-muted-foreground mt-1 block">via {topIssue.source}</span>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
