"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts"

interface SentimentChartProps {
  data: {
    positive: number
    negative: number
    neutral: number
  }
}

const COLORS = {
  positive: "#22c55e", // Green
  negative: "#ef4444", // Red
  neutral: "#6b7280", // Gray
}

export function SentimentChart({ data }: SentimentChartProps) {
  const chartData = [
    { name: "Positive", value: data.positive, fill: COLORS.positive },
    { name: "Negative", value: data.negative, fill: COLORS.negative },
    { name: "Neutral", value: data.neutral, fill: COLORS.neutral },
  ].filter((d) => d.value > 0)

  const total = data.positive + data.negative + data.neutral

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-foreground">
          Sentiment Analysis
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={2}
                dataKey="value"
                label={({ cx, cy, midAngle, outerRadius, name, percent }) => {
                  const RADIAN = Math.PI / 180
                  const radius = outerRadius + 25
                  const x = cx + radius * Math.cos(-midAngle * RADIAN)
                  const y = cy + radius * Math.sin(-midAngle * RADIAN)
                  return (
                    <text
                      x={x}
                      y={y}
                      fill="#e5e7eb"
                      textAnchor={x > cx ? "start" : "end"}
                      dominantBaseline="central"
                      fontSize={12}
                    >
                      {`${name} ${(percent * 100).toFixed(0)}%`}
                    </text>
                  )
                }}
                labelLine={{ stroke: "#9ca3af", strokeWidth: 1 }}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  color: "hsl(var(--popover-foreground))",
                }}
                formatter={(value: number) => [
                  `${value} issues (${((value / total) * 100).toFixed(1)}%)`,
                ]}
              />
              <Legend
                verticalAlign="bottom"
                height={36}
                formatter={(value) => (
                  <span className="text-sm text-muted-foreground">{value}</span>
                )}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
