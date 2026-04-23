"use client"

import { useMemo, useState, useEffect, useRef } from "react"
import { AlertTriangle, ExternalLink, ShieldCheck, ChevronDown, History, Layers3 } from "lucide-react"
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

// Cluster-label confidence comes from a self-reported score returned by the
// labelling model (see lib/storage/semantic-clusters.ts). Raw 2-decimal
// display (`0.82`) implies a calibrated precision the number does not carry.
// Bucket at display time; below 0.6 we refuse to show the label at all.
// Data-scientist review finding M1.
const LABEL_CONFIDENCE_SHOW_THRESHOLD = 0.6
const LABEL_CONFIDENCE_HIGH_THRESHOLD = 0.8

function bucketConfidence(confidence: number): "High" | "Medium" {
  return confidence >= LABEL_CONFIDENCE_HIGH_THRESHOLD ? "High" : "Medium"
}

function hasTrustedLabel(
  label: string | null,
  confidence: number | null,
): boolean {
  return label !== null && confidence !== null && confidence >= LABEL_CONFIDENCE_SHOW_THRESHOLD
}

export function ClassificationTriage({ records, stats, isLoading, activeCategory, timeDays, onRefresh }: ClassificationTriageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusOverride, setStatusOverride] = useState<string>("triaged")
  const [severityOverride, setSeverityOverride] = useState<string>("medium")
  const [categoryOverride, setCategoryOverride] = useState<string>("")
  const [reviewer, setReviewer] = useState<string>("")
  const [notes, setNotes] = useState<string>("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  // `groupFilter` is the (effective_category › subcategory) triage group
  // (Layer B). `semanticClusterFilter` is the real Layer-A semantic cluster
  // id. The two compose — a record must match both to survive `triageRecords`.
  const [groupFilter, setGroupFilter] = useState<string>("all")
  const [semanticClusterFilter, setSemanticClusterFilter] = useState<string>("all")

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

  const groups = useMemo(() => {
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

  // Real (Layer A) semantic clusters in the current scope. Groups by
  // observation-level `cluster_id`; records without a cluster membership
  // (clustering not yet run, embedding failed, below similarity threshold)
  // are skipped so the chip strip only shows actionable clusters.
  //
  // Deterministic title-hash fallback clusters (`title:<md5>` keys) are
  // only surfaced when they have multiple members — a `title:` singleton
  // carries no more information than the existing group-by and would
  // render as meaningless "Unlabelled cluster · 1 obs" noise next to
  // real semantic clusters (data-scientist review finding H2).
  const semanticClusters = useMemo(() => {
    type Bucket = {
      id: string
      key: string | null
      label: string | null
      label_confidence: number | null
      size: number
      total: number
    }
    const grouped = new Map<string, Bucket>()
    for (const record of globallyFilteredRecords) {
      if (!record.cluster_id) continue
      const current = grouped.get(record.cluster_id) ?? {
        id: record.cluster_id,
        key: record.cluster_key,
        label: record.cluster_label,
        label_confidence: record.cluster_label_confidence,
        size: record.cluster_size ?? 0,
        total: 0,
      }
      current.total += 1
      grouped.set(record.cluster_id, current)
    }
    return Array.from(grouped.values())
      .filter((c) => (c.key?.startsWith("semantic:") ?? false) || c.size >= 2)
      .sort((a, b) => b.total - a.total || b.size - a.size)
      .slice(0, 10)
  }, [globallyFilteredRecords])

  const triageRecords = useMemo(() => {
    return globallyFilteredRecords.filter((record) => {
      const groupMatch =
        groupFilter === "all" ||
        `${record.effective_category} › ${record.subcategory || "General"}` === groupFilter
      const semanticMatch =
        semanticClusterFilter === "all" || record.cluster_id === semanticClusterFilter
      return groupMatch && semanticMatch
    })
  }, [globallyFilteredRecords, groupFilter, semanticClusterFilter])
  const hasAnyRecords = records.length > 0
  const hasGroups = groups.length > 0
  const hasSemanticClusters = semanticClusters.length > 0
  const isPipelineEmpty = !isLoading && !hasAnyRecords
  const isScopedEmpty = !isLoading && hasAnyRecords && triageRecords.length === 0
  const emptyStateImpressionRef = useRef<string | null>(null)

  // Auto-select first record when either filter changes. Tracking both
  // filters in the ref keeps the detail panel in sync regardless of which
  // chip strip the reviewer interacts with.
  const prevFilterKeyRef = useRef(`${groupFilter}|${semanticClusterFilter}`)
  useEffect(() => {
    const key = `${groupFilter}|${semanticClusterFilter}`
    if (prevFilterKeyRef.current !== key) {
      prevFilterKeyRef.current = key
      if (triageRecords.length > 0) {
        const firstRecord = triageRecords[0]
        setSelectedId(firstRecord.id)
        setStatusOverride(firstRecord.effective_status)
        setSeverityOverride(firstRecord.effective_severity)
        setCategoryOverride(firstRecord.effective_category)
      }
    }
  }, [groupFilter, semanticClusterFilter, triageRecords])

  useEffect(() => {
    const stateKey = isPipelineEmpty ? "pipeline-empty" : isScopedEmpty ? "scoped-empty" : null

    if (!stateKey) {
      emptyStateImpressionRef.current = null
      return
    }

    if (emptyStateImpressionRef.current === stateKey) return
    emptyStateImpressionRef.current = stateKey

    // Analytics key `cluster_filter` preserved for back-compat with existing
    // funnels; populated from the renamed `groupFilter` state.
    void track("classification_triage_empty_state_impression", {
      empty_state: stateKey,
      active_category: activeCategory,
      time_days: timeDays,
      cluster_filter: groupFilter,
      semantic_cluster_filter: semanticClusterFilter,
      has_clusters: hasGroups,
      has_semantic_clusters: hasSemanticClusters,
      records_total: records.length,
      records_in_scope: globallyFilteredRecords.length,
    })
  }, [activeCategory, groupFilter, semanticClusterFilter, globallyFilteredRecords.length, hasGroups, hasSemanticClusters, isPipelineEmpty, isScopedEmpty, records.length, timeDays])

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
          Grouped classification lanes make it faster to jump into dense issue pockets and review related reports in one pass. Semantic clusters (below) surface reports that share a root cause regardless of how they were categorised.
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
              tool-use-failure, …). Showing all LLM classifications in scope. Use the group
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
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Top triage groups</p>
          <p className="text-xs text-muted-foreground">
            Virtual lanes by classified category × subcategory.
          </p>
          <div className="flex flex-wrap gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size="sm"
                    variant={groupFilter === "all" ? "default" : "outline"}
                    disabled={!hasGroups}
                    onClick={() => {
                      try {
                        setGroupFilter("all")
                      } catch (error) {
                        logClientError(error, "ClassificationTriageGroupFilterError", {
                          groupFilter,
                          targetFilter: "all",
                          context: "All groups button clicked",
                        })
                      }
                    }}
                  >
                    All groups
                  </Button>
                </span>
              </TooltipTrigger>
              {!hasGroups && (
                <TooltipContent>
                  Group filters are disabled until classification output is available.
                </TooltipContent>
              )}
            </Tooltip>
            {groups.map((group) => (
              <Button
                key={group.name}
                size="sm"
                variant={groupFilter === group.name ? "default" : "outline"}
                onClick={() => setGroupFilter(group.name)}
                className="gap-2"
              >
                <span className="truncate max-w-[220px]">{group.name}</span>
                <Badge variant="secondary">{group.total}</Badge>
                {group.highRisk > 0 && <Badge variant="destructive">{group.highRisk} high</Badge>}
              </Button>
            ))}
          </div>
        </div>

        {hasSemanticClusters && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              <Layers3 className="h-3.5 w-3.5" />
              Top semantic clusters
            </p>
            <p className="text-xs text-muted-foreground">
              Embedding-based groupings of observations that share a root cause across categories.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={semanticClusterFilter === "all" ? "default" : "outline"}
                onClick={() => {
                  try {
                    setSemanticClusterFilter("all")
                  } catch (error) {
                    logClientError(error, "ClassificationTriageSemanticClusterFilterError", {
                      semanticClusterFilter,
                      targetFilter: "all",
                      context: "All semantic clusters button clicked",
                    })
                  }
                }}
              >
                All clusters
              </Button>
              {semanticClusters.map((cluster) => {
                const displayLabel = hasTrustedLabel(cluster.label, cluster.label_confidence)
                  ? cluster.label!
                  : "Unlabelled cluster"
                // Chip text makes in-scope vs total disambiguation explicit:
                // the primary badge is the number visible right now, the
                // outline badge (when different) is the total active
                // membership. Tooltip spells it out for anyone unsure.
                const chipTitle = `${cluster.total} in current view · ${cluster.size} total observation${cluster.size === 1 ? "" : "s"}`
                return (
                  <Tooltip key={cluster.id}>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant={semanticClusterFilter === cluster.id ? "default" : "outline"}
                        onClick={() => {
                          try {
                            setSemanticClusterFilter(cluster.id)
                          } catch (error) {
                            logClientError(error, "ClassificationTriageSemanticClusterFilterError", {
                              semanticClusterFilter,
                              targetFilter: cluster.id,
                              context: "Semantic cluster chip clicked",
                            })
                          }
                        }}
                        className="gap-2"
                      >
                        <span className="truncate max-w-[220px]">{displayLabel}</span>
                        <Badge variant="secondary">{cluster.total} here</Badge>
                        {cluster.size > cluster.total && (
                          <Badge variant="outline">{cluster.size} total</Badge>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{chipTitle}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading classifications...</p>
        ) : isScopedEmpty ? (
          <p className="text-sm text-muted-foreground">
            {groupFilter !== "all" && semanticClusterFilter !== "all"
              ? `No records match both the "${groupFilter}" triage group and the selected semantic cluster. Clear one filter to widen the view.`
              : groupFilter !== "all"
                ? `No records match the "${groupFilter}" triage group. Clear it or widen the global sliders.`
                : semanticClusterFilter !== "all"
                  ? "No records match the selected semantic cluster. Clear it or widen the global sliders."
                  : "No classifier records in this scope. Adjust global sliders, the triage-group filter, or the semantic-cluster filter."}
          </p>
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

            {selected.cluster_id &&
              (selected.cluster_key?.startsWith("semantic:") ||
                (selected.cluster_size ?? 0) >= 2) && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                    <Layers3 className="h-3.5 w-3.5" />
                    Semantic cluster
                  </p>
                  <p className="mt-1 font-medium">
                    {hasTrustedLabel(selected.cluster_label, selected.cluster_label_confidence)
                      ? selected.cluster_label
                      : "Unlabelled cluster"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selected.cluster_size ?? 0} related observation
                    {(selected.cluster_size ?? 0) === 1 ? "" : "s"}
                    {hasTrustedLabel(selected.cluster_label, selected.cluster_label_confidence) && (
                      <>
                        {" · "}
                        {bucketConfidence(selected.cluster_label_confidence!)} confidence
                      </>
                    )}
                  </p>
                </div>
              )}

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
