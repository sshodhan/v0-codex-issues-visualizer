"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from "recharts"
import { AlertTriangle, Eye, TrendingUp } from "lucide-react"

interface PriorityMatrixProps {
  data: Array<{
    id: string
    title: string
    impact_score: number
    frequency_count: number
    sentiment: string
    category: { name: string; color: string } | null
  }>
}

type SentimentKey = "positive" | "negative" | "neutral"

const SENTIMENT_COLORS: Record<SentimentKey, string> = {
  positive: "#22c55e",
  negative: "#ef4444",
  neutral: "#6b7280",
}

const SENTIMENT_ORDER: SentimentKey[] = ["negative", "neutral", "positive"]

// Priority thresholds for zone classification
const ESCALATE_THRESHOLD = 40
const WATCH_THRESHOLD = 25

// Dominant sentiment threshold (40% or more of issues)
const DOMINANT_SENTIMENT_THRESHOLD = 0.4

const normalizeSentiment = (sentiment: string): SentimentKey => {
  if (sentiment === "positive" || sentiment === "negative" || sentiment === "neutral") {
    return sentiment
  }
  return "neutral"
}

type ZoneType = "escalate" | "watch" | "monitor"

const getZone = (priorityScore: number, negativeShare: number): ZoneType => {
  if (priorityScore >= ESCALATE_THRESHOLD && negativeShare >= DOMINANT_SENTIMENT_THRESHOLD) {
    return "escalate"
  }
  if (priorityScore >= WATCH_THRESHOLD) {
    return "watch"
  }
  return "monitor"
}

const getDominantSentiment = (
  counts: Record<SentimentKey, number>,
  total: number
): { sentiment: SentimentKey; share: number } | null => {
  if (total === 0) return null
  
  const shares = SENTIMENT_ORDER.map((s) => ({
    sentiment: s,
    share: counts[s] / total,
  }))
  
  const dominant = shares.reduce((best, curr) => 
    curr.share > best.share ? curr : best
  )
  
  return dominant.share >= 0.3 ? dominant : null
}

export function PriorityMatrix({ data }: PriorityMatrixProps) {
  const { chartData, avgPriority, zoneCategories } = useMemo(() => {
    const groupedByCategory = data.reduce<
      Record<
        string,
        {
          category: string
          issues: { title: string; impact: number; sentiment: SentimentKey }[]
          sentimentCounts: Record<SentimentKey, number>
          totalFrequency: number
          totalImpact: number
        }
      >
    >((acc, item) => {
      const categoryName = item.category?.name || "Uncategorized"

      if (!acc[categoryName]) {
        acc[categoryName] = {
          category: categoryName,
          issues: [],
          sentimentCounts: { positive: 0, negative: 0, neutral: 0 },
          totalFrequency: 0,
          totalImpact: 0,
        }
      }

      const sentiment = normalizeSentiment(item.sentiment)
      acc[categoryName].issues.push({
        title: item.title,
        impact: item.impact_score,
        sentiment,
      })
      acc[categoryName].sentimentCounts[sentiment] += 1
      acc[categoryName].totalFrequency += item.frequency_count
      acc[categoryName].totalImpact += item.impact_score

      return acc
    }, {})

    const lanes = Object.values(groupedByCategory)
    const maxFrequency = Math.max(...lanes.map((lane) => lane.totalFrequency), 1)

    const processed = lanes
      .map((lane, index) => {
        const issueCount = lane.issues.length
        const avgImpact = issueCount > 0 ? lane.totalImpact / issueCount : 0
        const normalizedImpact = avgImpact / 10
        const normalizedFrequency = lane.totalFrequency / maxFrequency
        const priorityScore = Math.round((normalizedImpact * 0.65 + normalizedFrequency * 0.35) * 100)

        const mix = SENTIMENT_ORDER.reduce<Record<SentimentKey, number>>(
          (acc, sentiment) => {
            acc[sentiment] = Math.round((lane.sentimentCounts[sentiment] / issueCount) * 100) || 0
            return acc
          },
          { negative: 0, neutral: 0, positive: 0 }
        )

        const negativeShare = issueCount > 0 ? lane.sentimentCounts.negative / issueCount : 0
        const zone = getZone(priorityScore, negativeShare)
        const dominant = getDominantSentiment(lane.sentimentCounts, issueCount)

        const representativeTitles = [...lane.issues]
          .sort((a, b) => b.impact - a.impact)
          .slice(0, 2)
          .map((issue) => issue.title)

        return {
          x: priorityScore,
          y: index,
          z: 220,
          category: lane.category,
          avgImpact: Number(avgImpact.toFixed(1)),
          issueCount,
          priorityScore,
          sentimentCounts: lane.sentimentCounts,
          sentimentMix: mix,
          negativeShare,
          zone,
          dominant,
          representativeTitles,
        }
      })
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .map((lane, index) => ({ ...lane, y: index }))

    const avg = processed.length > 0
      ? processed.reduce((sum, lane) => sum + lane.priorityScore, 0) / processed.length
      : 50

    // Group categories by zone for the actionable legend
    const zones: Record<ZoneType, string[]> = { escalate: [], watch: [], monitor: [] }
    for (const lane of processed) {
      zones[lane.zone].push(lane.category)
    }

    return { chartData: processed, avgPriority: avg, zoneCategories: zones }
  }, [data])

  const maxY = Math.max(chartData.length - 0.5, 0.5)

  return (
    <Card className="bg-card border-border col-span-full lg:col-span-2">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-lg font-semibold text-foreground">Priority Matrix</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Categories ranked by blended priority (65% impact + 35% frequency). Bars show sentiment distribution.
            </p>
          </div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]" />
              Negative
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#6b7280]" />
              Neutral
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
              Positive
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[380px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 20, right: 30, bottom: 50, left: 100 }}>
              {/* Background zones for visual context */}
              <ReferenceArea
                x1={ESCALATE_THRESHOLD}
                x2={100}
                y1={-0.5}
                y2={maxY}
                fill="#ef4444"
                fillOpacity={0.06}
              />
              <ReferenceArea
                x1={WATCH_THRESHOLD}
                x2={ESCALATE_THRESHOLD}
                y1={-0.5}
                y2={maxY}
                fill="#f59e0b"
                fillOpacity={0.05}
              />
              <ReferenceArea
                x1={0}
                x2={WATCH_THRESHOLD}
                y1={-0.5}
                y2={maxY}
                fill="#22c55e"
                fillOpacity={0.04}
              />
              
              <XAxis
                type="number"
                dataKey="x"
                name="Priority Score"
                domain={[0, 100]}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                tickLine={{ stroke: "hsl(var(--border))" }}
                axisLine={{ stroke: "hsl(var(--border))" }}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={[-0.5, maxY]}
                ticks={chartData.map((entry) => entry.y)}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                tickLine={{ stroke: "hsl(var(--border))" }}
                axisLine={{ stroke: "hsl(var(--border))" }}
                tickFormatter={(value) => {
                  const lane = chartData[value]
                  if (!lane) return ""
                  return `${lane.category} (${lane.issueCount})`
                }}
                width={95}
              />
              
              {/* Threshold lines with labels */}
              <ReferenceLine
                x={ESCALATE_THRESHOLD}
                stroke="#ef4444"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
                label={{
                  value: "Escalate",
                  position: "top",
                  fill: "#ef4444",
                  fontSize: 10,
                  fontWeight: 500,
                }}
              />
              <ReferenceLine
                x={WATCH_THRESHOLD}
                stroke="#f59e0b"
                strokeDasharray="4 4"
                strokeOpacity={0.6}
                label={{
                  value: "Watch",
                  position: "top",
                  fill: "#f59e0b",
                  fontSize: 10,
                  fontWeight: 500,
                }}
              />
              
              <Tooltip
                cursor={{ strokeDasharray: "3 3", stroke: "hsl(var(--muted-foreground))" }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const lane = payload[0].payload
                    const zoneLabel = lane.zone === "escalate" 
                      ? "Escalate First" 
                      : lane.zone === "watch" 
                        ? "Watch Closely" 
                        : "Monitor"
                    const zoneColor = lane.zone === "escalate"
                      ? "text-red-400"
                      : lane.zone === "watch"
                        ? "text-amber-400"
                        : "text-green-400"
                    
                    return (
                      <div className="rounded-lg bg-popover p-3 border border-border shadow-lg space-y-2 max-w-xs">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-semibold text-foreground">{lane.category}</p>
                          <Badge variant="outline" className={`text-xs ${zoneColor} border-current`}>
                            {zoneLabel}
                          </Badge>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          <span className="text-muted-foreground">Priority Score</span>
                          <span className="font-medium text-foreground">{lane.priorityScore}/100</span>
                          <span className="text-muted-foreground">Issue Count</span>
                          <span className="font-medium text-foreground">{lane.issueCount}</span>
                          <span className="text-muted-foreground">Avg Impact</span>
                          <span className="font-medium text-foreground">{lane.avgImpact}/10</span>
                        </div>
                        
                        <div className="pt-1 border-t border-border">
                          <p className="text-xs text-muted-foreground mb-1">Sentiment breakdown:</p>
                          <div className="flex gap-3 text-xs">
                            <span className="text-red-400">{lane.sentimentMix.negative}% negative</span>
                            <span className="text-gray-400">{lane.sentimentMix.neutral}% neutral</span>
                            <span className="text-green-400">{lane.sentimentMix.positive}% positive</span>
                          </div>
                        </div>
                        
                        {lane.representativeTitles.length > 0 && (
                          <div className="pt-1 border-t border-border">
                            <p className="text-xs text-muted-foreground mb-1">Top issues:</p>
                            <ul className="text-xs space-y-0.5">
                              {lane.representativeTitles.map((title: string, i: number) => (
                                <li key={i} className="text-foreground line-clamp-1">
                                  {title}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )
                  }
                  return null
                }}
              />
              
              <Scatter
                data={chartData}
                shape={({ cx, cy, payload }) => {
                  const total = payload.issueCount || 1
                  const segmentWidth = 48
                  let offset = -segmentWidth / 2

                  return (
                    <g>
                      {SENTIMENT_ORDER.map((sentiment) => {
                        const count = payload.sentimentCounts[sentiment]
                        const width = Math.max((count / total) * segmentWidth, count > 0 ? 5 : 0)

                        if (width === 0) return null

                        const rect = (
                          <rect
                            key={sentiment}
                            x={cx + offset}
                            y={cy - 7}
                            width={width}
                            height={14}
                            rx={3}
                            ry={3}
                            fill={SENTIMENT_COLORS[sentiment]}
                            opacity={0.9}
                            style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.15))" }}
                          />
                        )
                        offset += width
                        return rect
                      })}
                    </g>
                  )
                }}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        
        {/* Actionable zone legend with actual categories */}
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-red-400" />
              <span className="font-semibold text-sm text-red-400">Escalate First</span>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              Score {ESCALATE_THRESHOLD}+ with negative sentiment dominant
            </p>
            {zoneCategories.escalate.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {zoneCategories.escalate.map((cat) => (
                  <Badge key={cat} variant="secondary" className="text-xs bg-red-500/20 text-red-300 border-red-500/30">
                    {cat}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No categories in this zone</p>
            )}
          </div>
          
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Eye className="h-4 w-4 text-amber-400" />
              <span className="font-semibold text-sm text-amber-400">Watch Closely</span>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              Score {WATCH_THRESHOLD}-{ESCALATE_THRESHOLD - 1}, trending concerns
            </p>
            {zoneCategories.watch.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {zoneCategories.watch.map((cat) => (
                  <Badge key={cat} variant="secondary" className="text-xs bg-amber-500/20 text-amber-300 border-amber-500/30">
                    {cat}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No categories in this zone</p>
            )}
          </div>
          
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-green-400" />
              <span className="font-semibold text-sm text-green-400">Monitor</span>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              {"Score <"}{WATCH_THRESHOLD}, lower urgency items
            </p>
            {zoneCategories.monitor.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {zoneCategories.monitor.map((cat) => (
                  <Badge key={cat} variant="secondary" className="text-xs bg-green-500/20 text-green-300 border-green-500/30">
                    {cat}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No categories in this zone</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
