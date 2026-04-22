"use client"

import { useState, Fragment } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { ExternalLink, ChevronDown, ChevronUp, Filter } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"
import type { Issue } from "@/hooks/use-dashboard-data"
import { SignalLayers } from "@/components/dashboard/signal-layers"

interface IssuesTableProps {
  issues: Issue[]
  isLoading: boolean
  globalTimeLabel: string
  globalCategoryLabel: string
  observationCount?: number
  canonicalCount?: number
  onFilterChange: (filters: {
    sentiment?: string
    sortBy?: string
    order?: string
  }) => void
}

// Issues table with filters and clickable links
export function IssuesTable({
  issues,
  isLoading,
  globalTimeLabel,
  globalCategoryLabel,
  observationCount,
  canonicalCount,
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
    onFilterChange({
      sortBy: column,
      order: newOrder,
      sentiment: sentimentFilter === "all" ? undefined : sentimentFilter,
    })
  }

  const handleSentimentChange = (value: string) => {
    setSentimentFilter(value)
    onFilterChange({
      sentiment: value === "all" ? undefined : value,
      sortBy,
      order,
    })
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
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-lg font-semibold text-foreground">
              All Issues {observationCount !== undefined && canonicalCount !== undefined 
                ? `(${observationCount} observations across ${canonicalCount} signals)`
                : `(${issues.length})`}
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <Select value={sentimentFilter} onValueChange={handleSentimentChange}>
                <SelectTrigger className="w-[160px] bg-secondary border-border text-foreground">
                  <Filter className="mr-2 h-4 w-4" />
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

          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">Window: {globalTimeLabel}</Badge>
            <Badge variant="secondary">Cluster: {globalCategoryLabel}</Badge>
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
                  <Fragment key={issue.id}>
                    <TableRow
                      className="border-border hover:bg-secondary/50 cursor-pointer"
                      onClick={() => setExpandedId(expandedId === issue.id ? null : issue.id)}
                    >
                      <TableCell className="font-medium text-foreground">
                        <div className="flex flex-col gap-1.5">
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
                          <div className="flex flex-wrap items-center gap-1.5">
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
                            {/*
                              Error code chips use `outline` (not `destructive`)
                              so a row with any error doesn't scream red — zone
                              color in the Priority Matrix is the severity cue,
                              the table is a scannable list. Cap at 2 chips
                              per row; the full signal panel lives in the
                              expanded view.
                            */}
                            {issue.error_code && (
                              <Badge variant="outline" className="font-mono text-[10px] border-destructive/60 text-destructive">
                                {issue.error_code}
                              </Badge>
                            )}
                            {issue.top_stack_frame && (
                              <Badge variant="outline" className="font-mono text-[10px]">
                                {issue.top_stack_frame}
                              </Badge>
                            )}
                            {issue.llm_subcategory && (
                              <Badge variant="secondary" className="text-[10px]">
                                {issue.llm_subcategory}
                              </Badge>
                            )}
                          </div>
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
                    {expandedId === issue.id && (
                      <TableRow className="border-border bg-secondary/30">
                        <TableCell colSpan={6} className="p-4">
                          <div className="flex flex-col gap-3">
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
                            <SignalLayers
                              observationId={issue.id}
                              title={issue.title}
                              content={decodeHtmlEntities(issue.content) || null}
                              fingerprint={{
                                error_code: issue.error_code ?? null,
                                top_stack_frame: issue.top_stack_frame ?? null,
                                top_stack_frame_hash: issue.top_stack_frame_hash ?? null,
                                cli_version: issue.cli_version ?? null,
                                os: issue.fp_os ?? null,
                                shell: issue.fp_shell ?? null,
                                editor: issue.fp_editor ?? null,
                                model_id: issue.model_id ?? null,
                                repro_markers: issue.repro_markers ?? 0,
                                keyword_presence: issue.fp_keyword_presence ?? 0,
                                llm_subcategory: issue.llm_subcategory ?? null,
                                llm_primary_tag: issue.llm_primary_tag ?? null,
                                algorithm_version: issue.fingerprint_algorithm_version ?? null,
                              }}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
