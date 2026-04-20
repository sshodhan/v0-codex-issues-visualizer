"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
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
import { ExternalLink, ChevronDown, ChevronUp, Calendar, Filter } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"
import type { Issue } from "@/hooks/use-dashboard-data"

interface Category {
  name: string
  slug: string
  color: string
}

interface IssuesTableProps {
  issues: Issue[]
  isLoading: boolean
  categories?: Category[]
  onFilterChange: (filters: {
    sentiment?: string
    category?: string
    days?: number
    sortBy?: string
    order?: string
  }) => void
}

const TIME_WINDOWS = [
  { label: "All Time", value: 0 },
  { label: "Last 7 days", value: 7 },
  { label: "Last 14 days", value: 14 },
  { label: "Last 30 days", value: 30 },
  { label: "Last 90 days", value: 90 },
]

export function IssuesTable({
  issues,
  isLoading,
  categories = [],
  onFilterChange,
}: IssuesTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState("impact_score")
  const [order, setOrder] = useState("desc")
  const [sentimentFilter, setSentimentFilter] = useState("all")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [timeWindow, setTimeWindow] = useState(0)

  const handleSort = (column: string) => {
    const newOrder = sortBy === column && order === "desc" ? "asc" : "desc"
    setSortBy(column)
    setOrder(newOrder)
    onFilterChange({ 
      sortBy: column, 
      order: newOrder,
      sentiment: sentimentFilter === "all" ? undefined : sentimentFilter,
      category: categoryFilter === "all" ? undefined : categoryFilter,
      days: timeWindow || undefined,
    })
  }

  const handleSentimentChange = (value: string) => {
    setSentimentFilter(value)
    onFilterChange({ 
      sentiment: value === "all" ? undefined : value,
      category: categoryFilter === "all" ? undefined : categoryFilter,
      days: timeWindow || undefined,
      sortBy,
      order,
    })
  }

  const handleCategoryChange = (value: string) => {
    setCategoryFilter(value)
    onFilterChange({ 
      sentiment: sentimentFilter === "all" ? undefined : sentimentFilter,
      category: value === "all" ? undefined : value,
      days: timeWindow || undefined,
      sortBy,
      order,
    })
  }

  const handleTimeChange = (value: number[]) => {
    const days = value[0]
    setTimeWindow(days)
    onFilterChange({ 
      sentiment: sentimentFilter === "all" ? undefined : sentimentFilter,
      category: categoryFilter === "all" ? undefined : categoryFilter,
      days: days || undefined,
      sortBy,
      order,
    })
  }

  const getTimeLabel = () => {
    const window = TIME_WINDOWS.find(tw => tw.value === timeWindow)
    return window?.label || "All Time"
  }

  const getSentimentBadge = (sentiment: string) => {
    const variants = {
      positive: "bg-green-500/20 text-green-400 border-green-500/30",
      negative: "bg-red-500/20 text-red-400 border-red-500/30",
      neutral: "bg-gray-500/20 text-gray-400 border-gray-500/30",
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

  const decodeHtmlEntities = (text: string) => {
    if (!text) return ""
    return text
      .replace(/&#x2F;/g, "/")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]*>/g, "") // Strip HTML tags
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
        <div className="flex flex-col gap-4">
          {/* Title and basic filters row */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-lg font-semibold text-foreground">
              All Issues ({issues.length})
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <Select value={sentimentFilter} onValueChange={handleSentimentChange}>
                <SelectTrigger className="w-[140px] bg-secondary border-border text-foreground">
                  <SelectValue placeholder="Sentiment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sentiments</SelectItem>
                  <SelectItem value="positive">Positive</SelectItem>
                  <SelectItem value="negative">Negative</SelectItem>
                  <SelectItem value="neutral">Neutral</SelectItem>
                </SelectContent>
              </Select>

              <Select value={categoryFilter} onValueChange={handleCategoryChange}>
                <SelectTrigger className="w-[160px] bg-secondary border-border text-foreground">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat.slug} value={cat.slug}>
                      <span className="flex items-center gap-2">
                        <span 
                          className="h-2 w-2 rounded-full" 
                          style={{ backgroundColor: cat.color }}
                        />
                        {cat.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Time window slider */}
          <div className="flex items-center gap-4 p-3 rounded-lg bg-secondary/50">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground whitespace-nowrap">Time Window:</span>
            <div className="flex-1 max-w-md">
              <Slider
                value={[timeWindow]}
                onValueChange={handleTimeChange}
                max={90}
                step={7}
                className="cursor-pointer"
              />
            </div>
            <span className="text-sm font-medium text-foreground min-w-[100px]">
              {getTimeLabel()}
            </span>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.map((issue) => (
                  <>
                    <TableRow
                      key={issue.id}
                      className="border-border hover:bg-secondary/50"
                    >
                      <TableCell className="font-medium text-foreground">
                        <div className="flex flex-col gap-1.5">
                          {/* Clickable title with external link */}
                          {issue.url ? (
                            <a
                              href={issue.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 hover:underline flex items-center gap-1.5 line-clamp-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {issue.title}
                              <ExternalLink className="h-3 w-3 flex-shrink-0" />
                            </a>
                          ) : (
                            <span className="line-clamp-2">{issue.title}</span>
                          )}
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
                            className="h-2 rounded-full bg-blue-500"
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
                    </TableRow>
                    {/* Expandable content row on click */}
                    {expandedId === issue.id && (
                      <TableRow className="border-border bg-secondary/30">
                        <TableCell colSpan={6} className="p-4">
                          <div className="flex flex-col gap-2">
                            <p className="text-sm text-muted-foreground">
                              {decodeHtmlEntities(issue.content) || "No additional content"}
                            </p>
                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                              <span>Author: {issue.author || "Unknown"}</span>
                              <span>
                                Sentiment Score:{" "}
                                {(issue.sentiment_score * 100).toFixed(0)}%
                              </span>
                              {issue.url && (
                                <a 
                                  href={issue.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-400 hover:underline flex items-center gap-1"
                                >
                                  View Original <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
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
