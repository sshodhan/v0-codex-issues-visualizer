"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ExternalLink, ChevronDown, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"
import type { Issue } from "@/hooks/use-dashboard-data"

interface IssuesTableProps {
  issues: Issue[]
  isLoading: boolean
  onFilterChange: (filters: {
    sentiment?: string
    sortBy?: string
    order?: string
  }) => void
}

export function IssuesTable({
  issues,
  isLoading,
  onFilterChange,
}: IssuesTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState("impact_score")
  const [order, setOrder] = useState("desc")
  const [sentimentFilter, setSentimentFilter] = useState("all")

  const handleSort = (column: string) => {
    const newOrder = sortBy === column && order === "desc" ? "asc" : "desc"
    setSortBy(column)
    setOrder(newOrder)
    onFilterChange({ sortBy: column, order: newOrder })
  }

  const handleSentimentChange = (value: string) => {
    setSentimentFilter(value)
    onFilterChange({ sentiment: value === "all" ? undefined : value })
  }

  const getSentimentBadge = (sentiment: string) => {
    const variants = {
      positive: "bg-[hsl(var(--chart-5))]/20 text-[hsl(var(--chart-5))] border-[hsl(var(--chart-5))]/30",
      negative: "bg-[hsl(var(--chart-4))]/20 text-[hsl(var(--chart-4))] border-[hsl(var(--chart-4))]/30",
      neutral: "bg-[hsl(var(--chart-1))]/20 text-[hsl(var(--chart-1))] border-[hsl(var(--chart-1))]/30",
    }
    return (
      <Badge
        variant="outline"
        className={cn(
          "capitalize",
          variants[sentiment as keyof typeof variants]
        )}
      >
        {sentiment}
      </Badge>
    )
  }

  const SortIcon = ({ column }: { column: string }) => {
    if (sortBy !== column) return null
    return order === "desc" ? (
      <ChevronDown className="ml-1 h-4 w-4 inline" />
    ) : (
      <ChevronUp className="ml-1 h-4 w-4 inline" />
    )
  }

  return (
    <Card className="bg-card border-border col-span-full">
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-lg font-semibold text-foreground">
            All Issues ({issues.length})
          </CardTitle>
          <div className="flex gap-2">
            <Select value={sentimentFilter} onValueChange={handleSentimentChange}>
              <SelectTrigger className="w-[140px] bg-secondary border-border">
                <SelectValue placeholder="Sentiment" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sentiments</SelectItem>
                <SelectItem value="positive">Positive</SelectItem>
                <SelectItem value="negative">Negative</SelectItem>
                <SelectItem value="neutral">Neutral</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <p>No issues found</p>
            <p className="text-sm">Try refreshing data or adjusting filters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground w-[40%]">
                    Issue
                  </TableHead>
                  <TableHead className="text-muted-foreground">Source</TableHead>
                  <TableHead className="text-muted-foreground">
                    Sentiment
                  </TableHead>
                  <TableHead
                    className="text-muted-foreground cursor-pointer hover:text-foreground"
                    onClick={() => handleSort("impact_score")}
                  >
                    Impact
                    <SortIcon column="impact_score" />
                  </TableHead>
                  <TableHead
                    className="text-muted-foreground cursor-pointer hover:text-foreground"
                    onClick={() => handleSort("upvotes")}
                  >
                    Engagement
                    <SortIcon column="upvotes" />
                  </TableHead>
                  <TableHead
                    className="text-muted-foreground cursor-pointer hover:text-foreground"
                    onClick={() => handleSort("published_at")}
                  >
                    Date
                    <SortIcon column="published_at" />
                  </TableHead>
                  <TableHead className="text-muted-foreground w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.map((issue) => (
                  <>
                    <TableRow
                      key={issue.id}
                      className="border-border cursor-pointer hover:bg-secondary/50"
                      onClick={() =>
                        setExpandedId(expandedId === issue.id ? null : issue.id)
                      }
                    >
                      <TableCell className="font-medium text-foreground">
                        <div className="flex flex-col gap-1">
                          <span className="line-clamp-1">{issue.title}</span>
                          {issue.category && (
                            <Badge
                              variant="outline"
                              className="w-fit text-xs"
                              style={{
                                borderColor: issue.category.color,
                                color: issue.category.color,
                              }}
                            >
                              {issue.category.name}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {issue.source?.name || "Unknown"}
                      </TableCell>
                      <TableCell>{getSentimentBadge(issue.sentiment)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div
                            className="h-2 rounded-full bg-[hsl(var(--chart-1))]"
                            style={{ width: `${issue.impact_score * 10}%` }}
                          />
                          <span className="text-sm text-muted-foreground">
                            {issue.impact_score}/10
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <div className="flex flex-col text-sm">
                          <span>{issue.upvotes} upvotes</span>
                          <span className="text-xs">
                            {issue.comments_count} comments
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {issue.published_at
                          ? formatDistanceToNow(new Date(issue.published_at), {
                              addSuffix: true,
                            })
                          : "N/A"}
                      </TableCell>
                      <TableCell>
                        {issue.url && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => {
                              e.stopPropagation()
                              window.open(issue.url, "_blank")
                            }}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {expandedId === issue.id && (
                      <TableRow className="border-border bg-secondary/30">
                        <TableCell colSpan={7} className="p-4">
                          <div className="flex flex-col gap-2">
                            <p className="text-sm text-muted-foreground">
                              {issue.content || "No additional content"}
                            </p>
                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                              <span>Author: {issue.author || "Unknown"}</span>
                              <span>
                                Sentiment Score:{" "}
                                {(issue.sentiment_score * 100).toFixed(0)}%
                              </span>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
