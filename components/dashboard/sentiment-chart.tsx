"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts"

interface SentimentChartProps {
  data: {
    positive: number
    negative: number
    neutral: number
  }
}

const COLORS = {
  positive: "var(--positive)",
  negative: "var(--negative)",
  neutral: "var(--neutral)",
}

export function SentimentChart({ data }: SentimentChartProps) {
  const chartData = [
    { name: "Positive", value: data.positive, fill: COLORS.positive },
    { name: "Negative", value: data.negative, fill: COLORS.negative },
    { name: "Neutral", value: data.neutral, fill: COLORS.neutral },
  ].filter((d) => d.value > 0)

  const total = data.positive + data.negative + data.neutral

  return (
    <Card className="bg-card border-border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-foreground">
          Sentiment Analysis
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          {/* Pie Chart */}
          <div className="h-[200px] w-[200px] flex-shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    color: "hsl(var(--foreground))",
                  }}
                  formatter={(value: number) => [
                    `${value} issues (${((value / total) * 100).toFixed(1)}%)`,
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Legend with values */}
          <div className="flex flex-col gap-3">
            {chartData.map((item) => (
              <div key={item.name} className="flex items-center gap-3">
                <div
                  className="h-4 w-4 rounded-full flex-shrink-0"
                  style={{ backgroundColor: item.fill }}
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">
                    {item.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.value} issues ({((item.value / total) * 100).toFixed(0)}%)
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Total at bottom */}
        <div className="mt-4 pt-4 border-t border-border">
          <p className="text-sm text-muted-foreground">
            Total: <span className="text-foreground font-medium">{total} issues</span>
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
