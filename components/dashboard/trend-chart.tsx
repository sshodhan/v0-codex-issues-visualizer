"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts"
import { format, parseISO } from "date-fns"

interface TrendChartProps {
  data: Array<{
    date: string
    positive: number
    negative: number
    neutral: number
    total: number
  }>
}

export function TrendChart({ data }: TrendChartProps) {
  const formattedData = data.map((item) => ({
    ...item,
    dateLabel: format(parseISO(item.date), "MMM d"),
  }))

  return (
    <Card className="bg-card border-border shadow-sm col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-foreground">
          Issue Trends (Last 30 Days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={formattedData}
              margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="colorPositive" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--positive)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--positive)" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="colorNegative" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--negative)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--negative)" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="colorNeutral" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--neutral)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--neutral)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="dateLabel"
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  color: "hsl(var(--popover-foreground))",
                }}
              />
              <Legend
                verticalAlign="top"
                height={36}
                formatter={(value) => (
                  <span style={{ color: "hsl(var(--foreground))", fontSize: "14px", textTransform: "capitalize" }}>
                    {value}
                  </span>
                )}
              />
              <Area
                type="monotone"
                dataKey="negative"
                stackId="1"
                stroke="var(--negative)"
                fill="url(#colorNegative)"
              />
              <Area
                type="monotone"
                dataKey="neutral"
                stackId="1"
                stroke="var(--neutral)"
                fill="url(#colorNeutral)"
              />
              <Area
                type="monotone"
                dataKey="positive"
                stackId="1"
                stroke="var(--positive)"
                fill="url(#colorPositive)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
