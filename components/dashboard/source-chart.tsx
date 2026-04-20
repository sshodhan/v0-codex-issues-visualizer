"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts"

interface SourceChartProps {
  data: Array<{ name: string; count: number }>
}

const COLORS = [
  "#3b82f6", // Blue
  "#06b6d4", // Cyan
  "#8b5cf6", // Purple
  "#f97316", // Orange
  "#22c55e", // Green
  "#ec4899", // Pink
]

export function SourceChart({ data }: SourceChartProps) {
  const sortedData = [...data].sort((a, b) => b.count - a.count)

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-foreground">
          Issues by Source
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={sortedData}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
            >
              <XAxis 
                type="number" 
                stroke="#9ca3af" 
                tick={{ fill: "#e5e7eb", fontSize: 12 }}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={100}
                stroke="#9ca3af"
                tick={{ fill: "#e5e7eb", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  color: "hsl(var(--popover-foreground))",
                }}
                formatter={(value: number) => [`${value} issues`]}
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {sortedData.map((_, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={COLORS[index % COLORS.length]}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
