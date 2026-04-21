"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts"

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

const normalizeSentiment = (sentiment: string): SentimentKey => {
  if (sentiment === "positive" || sentiment === "negative" || sentiment === "neutral") {
    return sentiment
  }

  return "neutral"
}

export function PriorityMatrix({ data }: PriorityMatrixProps) {
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

  const chartData = lanes
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
        representativeTitles,
      }
    })
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .map((lane, index) => ({ ...lane, y: index }))

  const avgPriority =
    chartData.length > 0
      ? chartData.reduce((sum, lane) => sum + lane.priorityScore, 0) / chartData.length
      : 50

  return (
    <Card className="bg-card border-border col-span-full lg:col-span-2">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold text-foreground">Priority Matrix</CardTitle>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-[#ef4444]" />
              Negative
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-[#6b7280]" />
              Neutral
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-[#22c55e]" />
              Positive
            </span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Category lanes are ranked by blended priority; each marker shows sentiment mix within that story cluster.
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[350px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 20, right: 30, bottom: 40, left: 80 }}>
              <XAxis
                type="number"
                dataKey="x"
                name="Priority Score"
                domain={[0, 100]}
                stroke="#9ca3af"
                tick={{ fill: "#e5e7eb", fontSize: 12 }}
                label={{
                  value: "Normalized Priority Score",
                  position: "bottom",
                  fill: "#e5e7eb",
                  fontSize: 12,
                }}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={[-0.5, Math.max(chartData.length - 0.5, 0.5)]}
                ticks={chartData.map((entry) => entry.y)}
                stroke="#9ca3af"
                tick={{ fill: "#e5e7eb", fontSize: 12 }}
                tickFormatter={(value) => chartData[value]?.category || ""}
                label={{
                  value: "Category Lanes",
                  angle: -90,
                  position: "insideLeft",
                  fill: "#e5e7eb",
                  fontSize: 12,
                }}
              />
              <ReferenceLine x={avgPriority} stroke="#6b7280" strokeDasharray="3 3" />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  color: "hsl(var(--popover-foreground))",
                  maxWidth: "320px",
                }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const lane = payload[0].payload
                    return (
                      <div className="rounded-lg bg-popover p-3 border border-border shadow-lg space-y-1.5">
                        <p className="font-medium text-foreground text-sm">{lane.category}</p>
                        <p className="text-xs text-muted-foreground">
                          Sentiment mix: {lane.sentimentMix.negative}% negative, {lane.sentimentMix.neutral}% neutral, {" "}
                          {lane.sentimentMix.positive}% positive
                        </p>
                        <p className="text-xs text-muted-foreground">Average impact: {lane.avgImpact} / 10</p>
                        <div className="text-xs text-muted-foreground">
                          <p className="mb-1">Representative issues:</p>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {lane.representativeTitles.map((title: string) => (
                              <li key={title} className="line-clamp-1">
                                {title}
                              </li>
                            ))}
                          </ul>
                        </div>
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
                  const segmentWidth = 42
                  let offset = -segmentWidth / 2

                  return (
                    <g>
                      {SENTIMENT_ORDER.map((sentiment) => {
                        const count = payload.sentimentCounts[sentiment]
                        const width = Math.max((count / total) * segmentWidth, count > 0 ? 4 : 0)

                        if (width === 0) {
                          return null
                        }

                        const rect = (
                          <rect
                            key={sentiment}
                            x={cx + offset}
                            y={cy - 6}
                            width={width}
                            height={12}
                            rx={2}
                            ry={2}
                            fill={SENTIMENT_COLORS[sentiment]}
                            opacity={0.95}
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
        <div className="mt-4 grid grid-cols-2 gap-4 text-xs text-muted-foreground">
          <div className="rounded-md bg-secondary/50 p-2 text-center">
            <p className="font-medium">Narrative Watch</p>
            <p>Lower urgency or mixed sentiment lanes</p>
          </div>
          <div className="rounded-md bg-red-500/20 p-2 text-center">
            <p className="font-medium text-red-400">Escalate First</p>
            <p>High-priority lanes with dominant negative sentiment</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
