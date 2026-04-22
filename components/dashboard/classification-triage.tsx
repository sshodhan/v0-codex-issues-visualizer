"use client"

import { useMemo, useState, useEffect, useRef } from "react"
import { AlertTriangle, ExternalLink, ShieldCheck, ChevronDown, History } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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
import { formatDistanceToNow, subDays, format } from "date-fns"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import type { ClassificationRecord, ClassificationStats } from "@/hooks/use-dashboard-data"
import { reviewClassification } from "@/hooks/use-dashboard-data"
import { logClientError } from "@/lib/error-tracking/client-logger"
import { track } from "@vercel/analytics"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface ClassificationTriageProps {
  records: ClassificationRecord[]
  stats?: ClassificationStats
  isLoading: boolean
  activeCategory: string
  timeDays: number
  onRefresh: () => Promise<unknown>
}

const STATUS_OPTIONS = ["new", "triaged", "in-progress", "resolved", "wont-fix", "duplicate"] as const
const SEVERITY_OPTIONS = ["critical", "high", "medium", "low"] as const

export function ClassificationTriage({ records, stats, isLoading, activeCategory, timeDays, onRefresh }: ClassificationTriageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusOverride, setStatusOverride] = useState<string>("triaged")
  const [severityOverride, setSeverityOverride] = useState<string>("medium")
  const [categoryOverride, setCategoryOverride] = useState<string>("")
  const [reviewer, setReviewer] = useState<string>("")
  const [notes, setNotes] = useState<string>("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [clusterFilter, setClusterFilter] = useState<string>("all")

  // The global category filter at the top of the dashboard is a
  // *heuristic* slug from `categories.slug` (e.g. "bug",
  // "feature-request"), populated by lib/scrapers/shared.ts →
  // categorizeIssue. The classification triage queue, however, uses the
  // *LLM* category enum (e.g. "code-generation-quality",
  // "tool-use-failure"). The two namespaces are intentionally disjoint
  // (only "other" overlaps). Without this guard, navigating from the
  // hero "Review {category}" CTA into this tab silently filters to
  // zero rows, undermining the cron-backfill payoff.
  //
  // If the active category isn't a slug present in the LLM-side data,
  // ignore it (show all) and surface a notice below.
  const knownLlmCategorySlugs = useMemo(
    () => new Set(records.map((record) => record.effective_category.toLowerCase())),
    [records],
  )
  const globalFilterAppliesToLlmTab =
    activeCategory === "all" || knownLlmCategorySlugs.has(activeCategory)
  const effectiveCategoryFilter = globalFilterAppliesToLlmTab ? activeCategory : "all"

  const globallyFilteredRecords = useMemo(() => {
    const timeCutoff = timeDays > 0 ? subDays(new Date(), timeDays) : null

    return records.filter((record) => {
      const categoryMatch =
        effectiveCategoryFilter === "all" ||
        record.effective_category.toLowerCase() === effectiveCategoryFilter
      const timeMatch = !timeCutoff || new Date(record.created_at) >= timeCutoff
      return categoryMatch && timeMatch
    })
  }, [records, effectiveCategoryFilter, timeDays])

  const clusters = useMemo(() => {
    const grouped = new Map<string, { total: number; highRisk: number }>()
    for (const record of globallyFilteredRecords) {
      const key = `${record.effective_category} › ${record.subcategory || "General"}`
      const current = grouped.get(key) || { total: 0, highRisk: 0 }
      current.total += 1
      if (record.effective_severity === "critical" || record.effective_severity === "high") current.highRisk += 1
      grouped.set(key, current)
    }

    return Array.from(grouped.entries())
      .map(([name, values]) => ({ name, ...values }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
  }, [globallyFilteredRecords])

  const triageRecords = useMemo(() => {
    if (clusterFilter === "all") return globallyFilteredRecords
    return globallyFilteredRecords.filter((record) => `${record.effective_category} › ${record.subcategory || "General"}` === clusterFilter)
  }, [globallyFilteredRecords, clusterFilter])
  const hasAnyRecords = records.length > 0
  const hasClusters = clusters.length > 0
  const isPipelineEmpty = !isLoading && !hasAnyRecords
  const isScopedEmpty = !isLoading && hasAnyRecords && triageRecords.length === 0
  const emptyStateImpressionRef = useRef<string | null>(null)

  // Auto-select first record when cluster filter changes
  const prevClusterFilterRef = useRef(clusterFilter)
  useEffect(() => {
    if (prevClusterFilterRef.current !== clusterFilter) {
      prevClusterFilterRef.current = clusterFilter
      if (triageRecords.length > 0) {
        const firstRecord = triageRecords[0]
        console.log("[v0] Auto-selecting first record in new cluster:", firstRecord.id)
        setSelectedId(firstRecord.id)
        setStatusOverride(firstRecord.effective_status)
        setSeverityOverride(firstRecord.effective_severity)
        setCategoryOverride(firstRecord.effective_category)
      }
    }
  }, [clusterFilter, triageRecords])

  useEffect(() => {
    const stateKey = isPipelineEmpty ? "pipeline-empty" : isScopedEmpty ? "scoped-empty" : null

    if (!stateKey) {
      emptyStateImpressionRef.current = null
      return
    }

    if (emptyStateImpressionRef.current === stateKey) return
    emptyStateImpressionRef.current = stateKey

    void track("classification_triage_empty_state_impression", {
      empty_state: stateKey,
      active_category: activeCategory,
      time_days: timeDays,
      cluster_filter: clusterFilter,
      has_clusters: hasClusters,
      records_total: records.length,
      records_in_scope: globallyFilteredRecords.length,
    })
  }, [activeCategory, clusterFilter, globallyFilteredRecords.length, hasClusters, isPipelineEmpty, isScopedEmpty, records.length, timeDays])

  const selected = useMemo(
    () => triageRecords.find((record) => record.id === selectedId) || null,
    [triageRecords, selectedId]
  )

  const trimmedReviewer = reviewer.trim()
  const canSubmitReview = Boolean(selected) && trimmedReviewer.length > 0

  const submitReview = async () => {
    if (!selected) return
    if (!trimmedReviewer) return // API requires reviewed_by (audit trail)

    setIsSubmitting(true)
    try {
      await reviewClassification(selected.id, {
        status: statusOverride as (typeof STATUS_OPTIONS)[number],
        severity: severityOverride as (typeof SEVERITY_OPTIONS)[number],
        category: categoryOverride || selected.category,
        needs_human_review: false,
        reviewed_by: trimmedReviewer,
        reviewer_notes: notes || undefined,
      })
      await onRefresh()
      setNotes("")
      setSelectedId(null)
    } catch (error) {
      console.error("[v0] Failed to submit classification review:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Classification Triage & Reviewer Workflow
        </CardTitle>
        <CardDescription>
          Clustered classification lanes make it faster to jump into dense issue pockets and review related reports in one pass.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Total classifications</p>
            <p className="text-xl font-semibold">{stats?.total ?? records.length}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">In current scope</p>
            <p className="text-xl font-semibold">{globallyFilteredRecords.length}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Needs human review</p>
            <p className="text-xl font-semibold">{stats?.needsReviewCount ?? records.filter((r) => r.needs_human_review).length}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Traceability coverage</p>
            <p className="text-xl font-semibold">{stats?.traceabilityCoverage ?? 0}%</p>
          </div>
        </div>

        {!globalFilterAppliesToLlmTab && hasAnyRecords && (
          <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
            <p>
              Global category filter <span className="font-medium">"{activeCategory}"</span>{" "}
              uses the dashboard's heuristic taxonomy (Bug, Feature Request, Performance, …); LLM
              classifications use a different category enum (code-generation-quality,
              tool-use-failure, …). Showing all LLM classifications in scope. Use the cluster
              filter below to narrow.
            </p>
          </div>
        )}

        {isPipelineEmpty && (
          <div className="rounded-md border border-dashed bg-muted/30 p-4">
            <p className="text-sm font-medium">No AI classifications generated yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              This triage queue appears empty because classification output has not been produced for this project yet.
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Run the scrape + classification job to ingest fresh source feedback.</li>
              <li>Backfill classifications for historical feedback so older records show up here.</li>
            </ul>
          </div>
        )}

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Top classification clusters</p>
          <div className="flex flex-wrap gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size="sm"
                    variant={clusterFilter === "all" ? "default" : "outline"}
                    disabled={!hasClusters}
                    onClick={() => {
                      try {
                        setClusterFilter("all")
                      } catch (error) {
                        logClientError(error, "ClassificationTriageClusterFilterError", {
                          clusterFilter,
                          targetFilter: "all",
                          context: "All clusters button clicked",
                        })
                      }
                    }}
                  >
                    All clusters
                  </Button>
                </span>
              </TooltipTrigger>
              {!hasClusters && (
                <TooltipContent>
                  Cluster filters are disabled until classification output is available.
                </TooltipContent>
              )}
            </Tooltip>
            {clusters.map((cluster) => (
              <Button
                key={cluster.name}
                size="sm"
                variant={clusterFilter === cluster.name ? "default" : "outline"}
                onClick={() => setClusterFilter(cluster.name)}
                className="gap-2"
              >
                <span className="truncate max-w-[220px]">{cluster.name}</span>
                <Badge variant="secondary">{cluster.total}</Badge>
                {cluster.highRisk > 0 && <Badge variant="destructive">{cluster.highRisk} high</Badge>}
              </Button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading classifications...</p>
        ) : isScopedEmpty ? (
          <p className="text-sm text-muted-foreground">No classifier records in this scope. Adjust global sliders or cluster filter.</p>
        ) : isPipelineEmpty ? (
          <p className="text-sm text-muted-foreground">Run a scrape + classification job, then refresh this queue.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Sentiment</TableHead>
                  <TableHead>Source feedback</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {triageRecords.map((record) => (
                  <TableRow
                    key={record.id}
                    onClick={() => {
                      setSelectedId(record.id)
                      setStatusOverride(record.effective_status)
                      setSeverityOverride(record.effective_severity)
                      setCategoryOverride(record.effective_category)
                    }}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {record.effective_needs_human_review && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                        <span>{record.effective_category}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{record.subcategory}</p>
                    </TableCell>
                    <TableCell><Badge variant="outline">{record.effective_severity}</Badge></TableCell>
                    <TableCell>{Math.round(record.confidence * 100)}%</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{record.source_issue_sentiment || "unknown"}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      {record.source_issue_url ? (
                        <a
                          href={record.source_issue_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {record.source_issue_title || "Open source feedback"}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">missing source URL</span>
                      )}
                    </TableCell>
                    <TableCell>{record.effective_status}</TableCell>
                    <TableCell>{formatDistanceToNow(new Date(record.created_at), { addSuffix: true })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {selected && (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm font-medium">Reviewer panel for selected classification</p>
            <p className="text-sm text-muted-foreground">{selected.summary}</p>

            {/* Review History Panel */}
            {(selected.latest_review || selected.prior_classification_id) && (
              <Collapsible className="rounded-md border bg-muted/30">
                <CollapsibleTrigger className="flex w-full items-center justify-between p-3 text-sm font-medium hover:bg-muted/50">
                  <div className="flex items-center gap-2">
                    <History className="h-4 w-4 text-muted-foreground" />
                    <span>Review History</span>
                    {selected.latest_review && (
                      <Badge variant="secondary" className="ml-2">
                        {selected.latest_review.reviewed_by}
                      </Badge>
                    )}
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 p-3 pt-0">
                  {/* Current effective state */}
                  <div className="rounded-md border bg-background p-2">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Current effective state</p>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{selected.effective_category}</Badge>
                      <Badge variant="outline">{selected.effective_severity}</Badge>
                      <Badge variant="outline">{selected.effective_status}</Badge>
                    </div>
                  </div>

                  {/* Latest review if present */}
                  {selected.latest_review && (
                    <div className="rounded-md border p-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium">
                          Reviewed by {selected.latest_review.reviewed_by}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(selected.latest_review.reviewed_at), "MMM d, yyyy h:mm a")}
                        </p>
                      </div>
                      {selected.latest_review.reviewer_notes && (
                        <p className="text-xs text-muted-foreground mt-1 italic">
                          {selected.latest_review.reviewer_notes}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Baseline classification */}
                  <div className="rounded-md border border-dashed p-2 opacity-75">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium">
                        Initial classification by {selected.algorithm_version || "algorithm"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(selected.created_at), "MMM d, yyyy h:mm a")}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-1">
                      <Badge variant="outline" className="text-xs">{selected.category}</Badge>
                      <Badge variant="outline" className="text-xs">{selected.severity}</Badge>
                      <Badge variant="outline" className="text-xs">{selected.status}</Badge>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              <Select value={statusOverride} onValueChange={setStatusOverride}>
                <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={severityOverride} onValueChange={setSeverityOverride}>
                <SelectTrigger><SelectValue placeholder="Severity" /></SelectTrigger>
                <SelectContent>
                  {SEVERITY_OPTIONS.map((severity) => <SelectItem key={severity} value={severity}>{severity}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input value={categoryOverride} onChange={(event) => setCategoryOverride(event.target.value)} placeholder="Category override" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Your name, required for audit log" />
              <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Override rationale / notes" />
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={submitReview} disabled={isSubmitting || !canSubmitReview}>
                {isSubmitting ? "Saving..." : "Mark reviewed"}
              </Button>
              <Button variant="outline" onClick={() => onRefresh()} disabled={isSubmitting}>Refresh queue</Button>
              {!canSubmitReview && (
                <span className="text-xs text-muted-foreground">Reviewer name required</span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
