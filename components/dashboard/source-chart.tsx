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
  LabelList,
} from "recharts"

interface SourceChartProps {
  data: Array<{ name: string; count: number }>
}

// Chart colors using CSS variables for theme awareness
const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--primary)",
]

export function SourceChart({ data }: SourceChartProps) {
  const sortedData = [...data].sort((a, b) => b.count - a.count)

  return (
    <Card className="bg-card border-border shadow-sm">
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
                stroke="hsl(var(--muted-foreground))" 
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={100}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: "hsl(var(--foreground))", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  color: "hsl(var(--foreground))",
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
                <LabelList 
                  dataKey="count" 
                  position="right" 
                  fill="hsl(var(--foreground))"
                  fontSize={12}
                  fontWeight={500}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
