"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
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

const SENTIMENT_COLORS = {
  positive: "#22c55e", // Green
  negative: "#ef4444", // Red
  neutral: "#6b7280", // Gray
}

export function PriorityMatrix({ data }: PriorityMatrixProps) {
  const chartData = data.map((item) => ({
    x: item.frequency_count,
    y: item.impact_score,
    z: 100,
    title: item.title,
    sentiment: item.sentiment,
    category: item.category?.name || "Uncategorized",
    color:
      SENTIMENT_COLORS[item.sentiment as keyof typeof SENTIMENT_COLORS] ||
      SENTIMENT_COLORS.neutral,
  }))

  // Calculate medians for quadrant lines
  const avgFrequency =
    data.length > 0
      ? data.reduce((sum, d) => sum + d.frequency_count, 0) / data.length
      : 5
  const avgImpact =
    data.length > 0
      ? data.reduce((sum, d) => sum + d.impact_score, 0) / data.length
      : 5

  return (
    <Card className="bg-card border-border col-span-full lg:col-span-2">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold text-foreground">
            Priority Matrix
          </CardTitle>
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
          High impact + High frequency = Prioritize first
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[350px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 20, right: 20, bottom: 40, left: 20 }}>
              <XAxis
                type="number"
                dataKey="x"
                name="Frequency"
                domain={[0, "auto"]}
                stroke="#9ca3af"
                tick={{ fill: "#e5e7eb", fontSize: 12 }}
                label={{
                  value: "Frequency",
                  position: "bottom",
                  fill: "#e5e7eb",
                  fontSize: 12,
                }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="Impact"
                domain={[0, 10]}
                stroke="#9ca3af"
                tick={{ fill: "#e5e7eb", fontSize: 12 }}
                label={{
                  value: "Impact Score",
                  angle: -90,
                  position: "insideLeft",
                  fill: "#e5e7eb",
                  fontSize: 12,
                }}
              />
              <ZAxis type="number" dataKey="z" range={[50, 200]} />
              <ReferenceLine
                y={avgImpact}
                stroke="#6b7280"
                strokeDasharray="3 3"
              />
              <ReferenceLine
                x={avgFrequency}
                stroke="#6b7280"
                strokeDasharray="3 3"
              />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  color: "hsl(var(--popover-foreground))",
                  maxWidth: "300px",
                }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload
                    return (
                      <div className="rounded-lg bg-popover p-3 border border-border shadow-lg">
                        <p className="font-medium text-foreground text-sm mb-1 line-clamp-2">
                          {data.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Category: {data.category}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Impact: {data.y} | Frequency: {data.x}
                        </p>
                      </div>
                    )
                  }
                  return null
                }}
              />
              <Scatter name="Issues" data={chartData}>
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-xs text-muted-foreground">
          <div className="rounded-md bg-secondary/50 p-2 text-center">
            <p className="font-medium">Low Priority</p>
            <p>Low impact, Low frequency</p>
          </div>
          <div className="rounded-md bg-red-500/20 p-2 text-center">
            <p className="font-medium text-red-400">High Priority</p>
            <p>High impact, High frequency</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
