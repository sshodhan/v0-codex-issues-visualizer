"use client"

import { Activity, AlertTriangle, Eye, Clock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { ClusterRollupRow } from "@/hooks/use-dashboard-data"
import type { PipelineStateSummary } from "@/lib/classification/pipeline-state"
import { SURGE_CHIP_THRESHOLD_PCT } from "@/lib/classification/rollup-constants"

interface QuickStatsBarProps {
  clusters: ClusterRollupRow[]
  pipelineState?: PipelineStateSummary | null
  days: number
}

function StatPill({ 
  icon: Icon, 
  label, 
  value, 
  variant = "default" 
}: { 
  icon: React.ElementType
  label: string
  value: string | number
  variant?: "default" | "warning" | "success"
}) {
  const variantClasses = {
    default: "bg-muted/50 text-foreground",
    warning: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    success: "bg-green-500/10 text-green-600 border-green-500/20",
  }
  
  return (
    <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${variantClasses[variant]}`}>
      <Icon className="size-4" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  )
}

export function QuickStatsBar({ clusters, pipelineState, days }: QuickStatsBarProps) {
  // Calculate key metrics from clusters and pipeline state
  const totalObservations = pipelineState?.observations_in_window ?? 
    clusters.reduce((sum, c) => sum + c.count, 0)
  
  const unreviewed = clusters.reduce((sum, c) => {
    const reviewPressure = c.rail_scoring?.review_pressure_input ?? 
      Math.max(0, c.count - c.reviewed_count)
    return sum + reviewPressure
  }, 0)
  
  const surgeCount = clusters.filter(c => {
    const surgePct = c.surge_delta_pct
    return surgePct != null && surgePct >= SURGE_CHIP_THRESHOLD_PCT
  }).length
  
  const timeLabel = days === 0 ? "All time" : `${days}d`
  
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatPill 
        icon={Activity} 
        label="Observations" 
        value={totalObservations.toLocaleString()} 
      />
      <StatPill 
        icon={Eye} 
        label="Unreviewed" 
        value={unreviewed} 
        variant={unreviewed > 10 ? "warning" : "default"}
      />
      <StatPill 
        icon={AlertTriangle} 
        label="Surges" 
        value={surgeCount} 
        variant={surgeCount > 0 ? "warning" : "success"}
      />
      <Badge variant="outline" className="ml-auto text-xs font-normal text-muted-foreground">
        <Clock className="mr-1 size-3" />
        {timeLabel} window
      </Badge>
    </div>
  )
}
