"use client"

import Link from "next/link"
import { useMemo, useState, useEffect, useRef } from "react"
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  FlaskConical,
  History,
  Info,
  Layers3,
  Lightbulb,
  Quote,
  ScrollText,
  ShieldCheck,
  Tag,
  XCircle,
} from "lucide-react"
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
import type { ClassificationRecord, ClassificationStats, ClusterSummary } from "@/hooks/use-dashboard-data"
import { useClusters } from "@/hooks/use-dashboard-data"
import { pickPrimaryCta, type PrerequisiteStatus } from "@/lib/classification/prerequisites"
import { reviewClassification } from "@/hooks/use-dashboard-data"
import { logClientError } from "@/lib/error-tracking/client-logger"
import { track } from "@vercel/analytics"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ClassificationTabStrip } from "@/components/dashboard/classification-tab-strip"
import { ClusterTrustRibbon } from "@/components/dashboard/cluster-trust-ribbon"
import { getConfidenceBandDisplay } from "@/lib/classification/confidence-display"
import { DataProvenanceStrip } from "@/components/dashboard/data-provenance-strip"

interface ClassificationTriageProps {
  records: ClassificationRecord[]
  stats?: ClassificationStats
  isLoading: boolean
  activeCategory: string
  timeDays: number
  onRefresh: () => Promise<unknown>
  /** V1: original layout. V2: trust strip + heuristic vs LLM explainer. */
  uxVariant?: "v1" | "v2"
  lastSyncLabel: string
  asOfActive: boolean
  /** Issue count in global time window for the selected heuristic category (from stats breakdown). */
  heuristicScopeIssueCount: number
  /**
   * When set, the semantic-cluster filter is controlled (e.g. synced with `?cluster=` on the dashboard)
   * so the Story tab and triage can share one Layer-A cluster id.
   */
  semanticClusterControl?: { value: "all" | string; onChange: (id: "all" | string) => void }
  /**
   * When set (e.g. `?llm_category=` from Story), Layer-B scope uses this
   * `effective_category` slug instead of the global bar — avoids heuristic/LLM mismatch.
   * Omit or `"all"` = no override from URL.
   */
  overrideLlmCategoryFilter?: string
  /**
   * When set, triage group (`category › subcategory`) is controlled (e.g. `?triage_group=` from Story).
   */
  groupControl?: { value: string; onChange: (v: string) => void }
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

// `pickPrimaryCta` + PrerequisiteStatus shape live in
// lib/classification/prerequisites.ts so the decision tree can be tested
// without pulling React into node --test. See that file for the
// precedence ordering rationale.

export function ClassificationTriage({
  records,
  stats,
  isLoading,
  activeCategory,
  timeDays,
  onRefresh,
  uxVariant = "v2",
  lastSyncLabel,
  asOfActive,
  heuristicScopeIssueCount,
  semanticClusterControl,
  groupControl,
  overrideLlmCategoryFilter: overrideLlmFromParent,
}: ClassificationTriageProps) {
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
  const [internalGroupFilter, setInternalGroupFilter] = useState<string>("all")
  const isGroupControlled = Boolean(groupControl)
  const groupFilter = groupControl?.value ?? internalGroupFilter
  const setGroupFilter = (v: string) => {
    if (groupControl) groupControl.onChange(v)
    else setInternalGroupFilter(v)
  }
  const [internalSemanticClusterFilter, setInternalSemanticClusterFilter] = useState<string>("all")
  const isSemanticClusterControlled = Boolean(semanticClusterControl)
  const semanticClusterFilter = semanticClusterControl?.value ?? internalSemanticClusterFilter
  const setSemanticClusterFilter = (id: string) => {
    if (semanticClusterControl) {
      semanticClusterControl.onChange(id === "all" ? "all" : id)
    } else {
      setInternalSemanticClusterFilter(id)
    }
  }

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
  const urlLlmRaw =
    overrideLlmFromParent && overrideLlmFromParent.toLowerCase() !== "all"
      ? overrideLlmFromParent.trim().toLowerCase()
      : null
  const useUrlLlm = Boolean(urlLlmRaw)
  const globalFilterAppliesToLlmTab =
    activeCategory === "all" || knownLlmCategorySlugs.has(activeCategory)
  const effectiveCategoryFilter = useUrlLlm
    ? (urlLlmRaw as string)
    : globalFilterAppliesToLlmTab
      ? activeCategory
      : "all"

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

  // Real (Layer A) semantic clusters in the current time window. Sourced
  // from /api/clusters (mv_observation_current join), NOT from the
  // classification records — so the chip strip shows up even when 0
  // classifications exist yet. Previously the strip derived from
  // `records.map(r => r.cluster_id)` which left clusters invisible
  // until classify-backfill ran. See docs/CLUSTERING_DESIGN.md §7.
  //
  // The API already applies the `semantic:` / `size >= 2` filter so
  // title-hash singletons stay out of the chip strip (data-scientist
  // review finding H2).
  const { clusters: semanticClusters } = useClusters({
    days: timeDays > 0 ? timeDays : undefined,
    limit: 10,
  })

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
  const urlClusterInSample =
    !semanticClusterControl ||
    semanticClusterControl.value === "all" ||
    semanticClusters.some((c) => c.id === semanticClusterControl.value)
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
  const selectedConfidenceDisplay = selected
    ? getConfidenceBandDisplay({
        confidence: selected.confidence,
        needsHumanReview: selected.effective_needs_human_review,
        retriedWithLargeModel: selected.retried_with_large_model,
      })
    : null

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

  const isV2 = uxVariant === "v2"

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl sm:text-2xl">
              <ShieldCheck className="h-5 w-5 text-primary" />
              {isV2 ? "AI triage — review & clusters" : "Classification Triage & Reviewer Workflow"}
            </CardTitle>
            <CardDescription className={isV2 ? "mt-2 text-sm leading-relaxed max-w-3xl" : undefined}>
              {isV2
                ? "Each row is an LLM classification linked to public source feedback. Layer B groups (category × subcategory) and Layer A semantic clusters help you clear related items together — reviews append to an audit trail."
                : "Grouped classification lanes make it faster to jump into dense issue pockets and review related reports in one pass. Semantic clusters (below) surface reports that share a root cause regardless of how they were categorised."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isV2 && (
          <ClassificationTabStrip
            lastSyncLabel={lastSyncLabel}
            asOfActive={asOfActive}
            timeDays={timeDays}
            issueCountInScope={heuristicScopeIssueCount}
            classificationRowCount={globallyFilteredRecords.length}
            pipelineState={stats?.pipeline_state ?? null}
          />
        )}
        {!isV2 && (
          <DataProvenanceStrip
            lastSyncLabel={lastSyncLabel}
            issueWindowLabel={timeDays === 0 ? "All time" : `Last ${timeDays} days`}
            asOfActive={asOfActive}
            pipelineState={stats?.pipeline_state ?? null}
          />
        )}

        <div className={`grid gap-3 sm:grid-cols-4 ${isV2 ? "rounded-lg border border-border/60 bg-card p-3 sm:p-4" : ""}`}>
          <div className={`rounded-md border p-3 ${isV2 ? "bg-muted/20" : ""}`}>
            <p className="text-xs text-muted-foreground">Total classifications</p>
            <p className="text-xl font-semibold tabular-nums">{stats?.total ?? records.length}</p>
            {isV2 && <p className="text-[10px] text-muted-foreground mt-1">In database for this app</p>}
          </div>
          <div className={`rounded-md border p-3 ${isV2 ? "bg-muted/20" : ""}`}>
            <p className="text-xs text-muted-foreground">In current scope</p>
            <p className="text-xl font-semibold tabular-nums">{globallyFilteredRecords.length}</p>
            {isV2 && <p className="text-[10px] text-muted-foreground mt-1">After time + category filter</p>}
          </div>
          <div className={`rounded-md border p-3 ${isV2 ? "bg-muted/20" : ""}`}>
            <p className="text-xs text-muted-foreground">Needs human review</p>
            <p className="text-xl font-semibold tabular-nums">
              {stats?.needsReviewCount ?? records.filter((r) => r.needs_human_review).length}
            </p>
            {isV2 && <p className="text-[10px] text-muted-foreground mt-1">From stats or row scan</p>}
          </div>
          <div className={`rounded-md border p-3 ${isV2 ? "bg-muted/20" : ""}`}>
            <p className="text-xs text-muted-foreground">Traceability coverage</p>
            <p className="text-xl font-semibold tabular-nums">{stats?.traceabilityCoverage ?? 0}%</p>
            {isV2 && <p className="text-[10px] text-muted-foreground mt-1">With source link</p>}
          </div>
        </div>

        {useUrlLlm && (
          <div className="flex items-start gap-2 rounded-md border border-dashed border-primary/40 bg-primary/5 p-3 text-sm text-muted-foreground" id="triage-llm-link-scope">
            <span className="text-xs font-semibold uppercase tracking-wide text-primary">LLM filter</span>
            <p>
              Scoping the queue by LLM <span className="font-medium">effective_category</span> from the URL (
              <span className="font-mono text-xs text-foreground">{urlLlmRaw}</span>
              ) — the global category bar is heuristic-only and may not match; that is expected.
            </p>
          </div>
        )}

        {!useUrlLlm && !globalFilterAppliesToLlmTab && hasAnyRecords && (
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

        <LayerExplainerPanel />

        {isPipelineEmpty && (
          <PipelineStatusPanel
            prereq={stats?.prerequisites ?? null}
            timeDays={timeDays}
            isV2={isV2}
          />
        )}

        {/* Partial-pipeline summary: rendered when SOME classifications exist
            but the pipeline is behind. Pipeline-empty is already handled by
            PipelineStatusPanel above; this surface keeps the prereq link
            visible during the more common partial state so reviewers can
            jump to /admin to clear the backlog without scrolling away. */}
        {!isPipelineEmpty && (
          <PartialPipelineStrip prereq={stats?.prerequisites ?? null} timeDays={timeDays} />
        )}

        <div className="space-y-2 rounded-md border p-3" id="triage-top-groups">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono">B</Badge>
            Top triage groups
          </p>
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

        {(hasSemanticClusters || isSemanticClusterControlled) && (
          <div className="space-y-2 rounded-md border p-3" id="triage-semantic-clusters">
            <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono">A</Badge>
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
              {isSemanticClusterControlled &&
                semanticClusterControl!.value !== "all" &&
                !urlClusterInSample && (
                  <Button size="sm" variant="default" className="gap-2" disabled>
                    <span className="truncate max-w-[200px]">From link</span>
                    <Badge variant="secondary">active</Badge>
                  </Button>
                )}
              {semanticClusters.map((cluster) => {
                const displayLabel = hasTrustedLabel(cluster.label, cluster.label_confidence)
                  ? cluster.label!
                  : "Unlabelled cluster"
                // Chip text makes in-scope vs total disambiguation
                // explicit: primary badge is observations visible in the
                // current window, outline badge (when different) is the
                // total active membership. Tooltip spells it out.
                const chipTitle = `${cluster.in_window} in current view · ${cluster.size} total observation${cluster.size === 1 ? "" : "s"}${cluster.classified_count > 0 ? ` · ${cluster.classified_count} classified` : ""}`
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
                        <Badge variant="secondary">{cluster.in_window} here</Badge>
                        {cluster.size > cluster.in_window && (
                          <Badge variant="outline">{cluster.size} total</Badge>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="space-y-1">
                        <p>{chipTitle}</p>
                        <ClusterTrustRibbon cluster={cluster} />
                      </div>
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </div>
        )}

        {semanticClusterFilter !== "all" && (
          <ClusterMemberPreview
            cluster={semanticClusters.find((c) => c.id === semanticClusterFilter) ?? null}
            show={isPipelineEmpty || triageRecords.length === 0}
          />
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
                {triageRecords.map((record) => {
                  const confidenceDisplay = getConfidenceBandDisplay({
                    confidence: record.confidence,
                    needsHumanReview: record.effective_needs_human_review,
                    retriedWithLargeModel: record.retried_with_large_model,
                  })
                  return (
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
                      <LayerBreadcrumb record={record} compact />
                    </TableCell>
                    <TableCell><Badge variant="outline">{record.effective_severity}</Badge></TableCell>
                    <TableCell>
                      <span
                        className="text-xs font-medium"
                        title={confidenceDisplay.modelScoreLabel}
                      >
                        {confidenceDisplay.band}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{record.source_issue_sentiment || "unknown"}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <div className="flex flex-col gap-1">
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
                        {record.observation_id ? (
                          <Link
                            href={`/admin?tab=trace&observation=${record.observation_id}`}
                            onClick={(event) => event.stopPropagation()}
                            className="text-xs text-primary hover:underline"
                          >
                            Open trace
                          </Link>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>{record.effective_status}</TableCell>
                    <TableCell>{formatDistanceToNow(new Date(record.created_at), { addSuffix: true })}</TableCell>
                  </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {selected && selectedConfidenceDisplay && (
          <div className="space-y-3 rounded-lg border p-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Reviewer panel for selected classification</p>
                <Badge
                  variant="outline"
                  className="px-1.5 py-0 text-[10px] font-mono uppercase"
                  title={selectedConfidenceDisplay.modelScoreLabel}
                >
                  C · {selectedConfidenceDisplay.band}
                </Badge>
              </div>
              <LayerBreadcrumb record={selected} />
            </div>
            <p className="text-sm text-muted-foreground">{selected.summary}</p>
            {selected.observation_id ? (
              <div>
                <Link
                  href={`/admin?tab=trace&observation=${selected.observation_id}`}
                  className="text-xs text-primary hover:underline"
                >
                  Open unified observation trace
                </Link>
              </div>
            ) : null}

            <PerRecordPrereqHints record={selected} />

            {selected.cluster_id &&
              (selected.cluster_key?.startsWith("semantic:") ||
                (selected.cluster_size ?? 0) >= 2) && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono">A</Badge>
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

            <ClassificationContextPanel record={selected} />

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

// Rendered inline for `isPipelineEmpty` — replaces the previous generic
// "No AI classifications yet" block with a live status breakdown and
// deep-links into the relevant admin tabs. Data comes from
// `/api/classifications/stats`'s `prerequisites` field; when that's null
// (server-side fetch failed) we fall back to a terse message so the
// reviewer still sees *something* instead of a blank card.
function PipelineStatusPanel({
  prereq,
  timeDays,
  isV2,
}: {
  prereq: PrerequisiteStatus | null
  timeDays: number
  isV2: boolean
}) {
  const wrapperClass = isV2
    ? "rounded-lg border-2 border-dashed border-border bg-muted/15 p-5 space-y-4"
    : "rounded-md border border-dashed bg-muted/30 p-4 space-y-3"
  const headingClass = isV2 ? "text-base font-semibold" : "text-sm font-medium"

  if (!prereq) {
    return (
      <div className={wrapperClass}>
        <p className={headingClass}>No AI classifications generated yet</p>
        <p className="text-sm text-muted-foreground">
          Pipeline status unavailable — check server logs. Run a scrape + classification job and
          refresh this queue.
        </p>
      </div>
    )
  }

  const windowLabel = timeDays === 0 ? "all time" : `last ${timeDays} days`
  const cta = pickPrimaryCta(prereq)
  // Secondary CTA surfaces when classify-backfill is the primary but
  // clustering is also behind — avoids making the reviewer take two
  // round-trips through the panel. Only shown when BOTH filters are
  // non-trivial; otherwise a single primary CTA keeps the panel terse.
  const showSecondaryClusteringCta =
    cta.kind === "classify-backfill" && prereq.pendingClustering > 0

  const fmtWhen = (at: string | null) => {
    if (!at) return "never"
    try {
      return formatDistanceToNow(new Date(at), { addSuffix: true })
    } catch {
      return "unknown"
    }
  }

  return (
    <div className={wrapperClass}>
      <div>
        <p className={headingClass}>No AI classifications generated yet — pipeline status</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Counts for the current window ({windowLabel}). Click an action below to trigger the
          missing step from the admin panel.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <StatusRow
          kind={prereq.observationsInWindow > 0 ? "ok" : "missing"}
          label="Observations in scope"
          value={`${prereq.observationsInWindow} in ${windowLabel}`}
        />
        <StatusRow
          kind={progressKind(prereq.clusteredCount, prereq.observationsInWindow)}
          label="Semantic clustering"
          value={progressLabel(prereq.clusteredCount, prereq.observationsInWindow, "clustered")}
        />
        <StatusRow
          kind={progressKind(prereq.classifiedCount, prereq.observationsInWindow)}
          label="Classifications"
          value={progressLabel(prereq.classifiedCount, prereq.observationsInWindow, "classified")}
        />
        <StatusRow
          kind={prereq.openaiConfigured ? "ok" : "error"}
          label="OpenAI API key"
          value={prereq.openaiConfigured ? "configured" : "missing — backfill will 503"}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 text-xs text-muted-foreground">
        <span>
          Last scrape: <span className="text-foreground">{fmtWhen(prereq.lastScrape.at)}</span>
        </span>
        <span>
          Last classify-backfill:{" "}
          <span className="text-foreground">{fmtWhen(prereq.lastClassifyBackfill.at)}</span>
        </span>
      </div>

      {cta.kind !== "none" && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {cta.kind === "openai-missing" ? (
            <div className="inline-flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              <span>
                Set <code>OPENAI_API_KEY</code> in project env before running backfill.
              </span>
            </div>
          ) : (
            <a
              href={cta.href}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {cta.label}
              <ArrowRight className="h-4 w-4" />
            </a>
          )}
          {showSecondaryClusteringCta && (
            <a
              href="/admin?tab=clustering"
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              Rebuild clustering
              <ArrowRight className="h-4 w-4" />
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function progressKind(
  have: number,
  total: number,
): "ok" | "partial" | "missing" {
  if (total === 0) return "missing"
  if (have >= total) return "ok"
  if (have > 0) return "partial"
  return "missing"
}

function progressLabel(have: number, total: number, verb: string): string {
  if (total === 0) return `0 ${verb}`
  const pct = Math.round((have / total) * 100)
  return `${have}/${total} ${verb} (${pct}%)`
}

function StatusRow({
  kind,
  label,
  value,
}: {
  kind: "ok" | "partial" | "missing" | "error"
  label: string
  value: string
}) {
  const icon =
    kind === "ok" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
    ) : kind === "partial" ? (
      <CircleDashed className="h-4 w-4 text-amber-500 flex-shrink-0" />
    ) : kind === "error" ? (
      <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />
    ) : (
      <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
    )
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-background/50 p-2">
      {icon}
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium truncate">{value}</p>
      </div>
    </div>
  )
}

// Expands below the chip strip when a cluster is selected but there's
// nothing in the triage table to filter (either pre-classification, or
// the compound filter pruned everything). Shows the cluster's top-impact
// member observations straight from /api/clusters so a reviewer can see
// what's actually in the cluster instead of staring at an empty table.
function ClusterMemberPreview({
  cluster,
  show,
}: {
  cluster: ClusterSummary | null
  show: boolean
}) {
  if (!show || !cluster) return null
  const displayLabel = hasTrustedLabel(cluster.label, cluster.label_confidence)
    ? cluster.label!
    : "Unlabelled cluster"
  const extraMembers = Math.max(0, cluster.in_window - cluster.samples.length)
  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Layers3 className="h-4 w-4 text-primary" />
        <p className="text-sm font-medium">{displayLabel}</p>
        <Badge variant="secondary">{cluster.in_window} in view</Badge>
        {cluster.classified_count > 0 && (
          <Badge variant="outline">{cluster.classified_count} classified</Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Sample member observations (highest impact first). Once classify-backfill runs against
        these, they'll appear in the triage table above and the classified count will rise.
      </p>
      <ClusterTrustRibbon cluster={cluster} />
      <ul className="space-y-1 text-sm">
        {cluster.samples.map((sample) => (
          <li key={sample.observation_id} className="flex items-start gap-2">
            <Badge variant="outline" className="mt-0.5 text-xs">
              {sample.impact_score.toFixed(1)}
            </Badge>
            {sample.url ? (
              <a
                href={sample.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-start gap-1 text-primary hover:underline"
              >
                <span className="truncate">{sample.title}</span>
                <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0" />
              </a>
            ) : (
              <span className="text-muted-foreground">{sample.title}</span>
            )}
          </li>
        ))}
      </ul>
      {extraMembers > 0 && (
        <p className="text-xs text-muted-foreground">
          + {extraMembers} more in this cluster not shown
        </p>
      )}
    </div>
  )
}

// Persists the open/closed state of the layered explainer so repeat
// reviewers don't pay a full panel of vertical space every visit. SSR
// fallback is "closed" — first render matches the server, then opens
// from localStorage on mount if the user had it expanded.
const LAYER_EXPLAINER_STORAGE_KEY = "classification-triage:layer-explainer-open"

function LayerExplainerPanel() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LAYER_EXPLAINER_STORAGE_KEY)
      if (stored === "1") setOpen(true)
    } catch {
      // localStorage unavailable (private mode, SSR) — leave closed
    }
  }, [])

  const handleToggle = (next: boolean) => {
    setOpen(next)
    try {
      window.localStorage.setItem(LAYER_EXPLAINER_STORAGE_KEY, next ? "1" : "0")
    } catch {
      // ignore
    }
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={handleToggle}
      className="rounded-md border bg-muted/10"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 p-3 text-sm hover:bg-muted/30">
        <div className="inline-flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">How this works — three layers of context</span>
        </div>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 p-3 pt-0 text-sm">
        <p className="text-xs text-muted-foreground">
          Every reviewable item is anchored at three layers. Filters compose with AND across
          Layer A and Layer B; Layer C is the row you click.
        </p>
        <LayerExplainerRow
          letter="A"
          icon={<Layers3 className="h-4 w-4 text-primary" />}
          title="Semantic cluster"
          body="Embedding-based grouping of observations that share a root cause across categories. Sourced from /api/clusters and visible the moment ingest assigns a cluster_id — independent of whether classification has run yet."
          adminLink={{ href: "/admin?tab=clustering", label: "Clustering admin" }}
        />
        <LayerExplainerRow
          letter="B"
          icon={<Tag className="h-4 w-4 text-primary" />}
          title="Triage group"
          body="Client-side group-by on (effective_category × subcategory). Comes from the LLM classification enum (code-generation-quality, tool-use-failure, …) — distinct from the dashboard's heuristic taxonomy used by the global slider."
          adminLink={{ href: "/admin?tab=classify-backfill", label: "Classify backfill" }}
        />
        <LayerExplainerRow
          letter="C"
          icon={<ScrollText className="h-4 w-4 text-primary" />}
          title="Classification (the row)"
          body="A single LLM-structured judgement: severity, status, reproducibility, impact, evidence quotes, root-cause hypothesis, suggested fix. Selecting a row opens the full context + reviewer override controls below the table."
          adminLink={null}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}

function LayerExplainerRow({
  letter,
  icon,
  title,
  body,
  adminLink,
}: {
  letter: "A" | "B" | "C"
  icon: React.ReactNode
  title: string
  body: string
  adminLink: { href: string; label: string } | null
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-background/50 p-3">
      <Badge variant="outline" className="mt-0.5 px-1.5 py-0 font-mono">{letter}</Badge>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="inline-flex items-center gap-2">
          {icon}
          <span className="text-sm font-medium">{title}</span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
        {adminLink && (
          <a
            href={adminLink.href}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {adminLink.label} <ArrowRight className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  )
}

// Surfaces a one-line prereq summary when records exist but the pipeline
// is behind. Pipeline-empty is handled by PipelineStatusPanel; this is
// for the "we have *some* data, but admin action would unblock the
// rest" middle state. Hidden when caught up.
function PartialPipelineStrip({
  prereq,
  timeDays,
}: {
  prereq: PrerequisiteStatus | null
  timeDays: number
}) {
  if (!prereq) return null
  const cta = pickPrimaryCta(prereq)
  // Only render when there's an actionable next step. caught-up state
  // (cta.kind === "none") is silent — no need to nag the reviewer.
  if (cta.kind === "none") return null

  const windowLabel = timeDays === 0 ? "all time" : `last ${timeDays}d`
  const total = prereq.observationsInWindow
  const classifyPct = total > 0 ? Math.round((prereq.classifiedCount / total) * 100) : 0
  const clusterPct = total > 0 ? Math.round((prereq.clusteredCount / total) * 100) : 0

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
      <AlertCircle className="h-4 w-4 flex-shrink-0 text-amber-500" />
      <span className="text-xs text-muted-foreground">
        Pipeline behind ({windowLabel}):{" "}
        <span className="text-foreground tabular-nums">{classifyPct}%</span> classified ·{" "}
        <span className="text-foreground tabular-nums">{clusterPct}%</span> clustered
      </span>
      {cta.kind === "openai-missing" ? (
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3" /> set <code className="font-mono">OPENAI_API_KEY</code>
        </span>
      ) : (
        <a
          href={cta.href}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {cta.label} <ArrowRight className="h-3 w-3" />
        </a>
      )}
    </div>
  )
}


// Compact A › B › C breadcrumb. Used in two places:
//   - row cell (compact = true): one-line, truncated cluster label, no
//     C suffix (the row is itself the C item).
//   - reviewer panel header (compact = false): full breadcrumb with the
//     classification id suffix, useful when copying for chat handoff.
function LayerBreadcrumb({
  record,
  compact = false,
}: {
  record: ClassificationRecord
  compact?: boolean
}) {
  const clusterLabel = record.cluster_id
    ? hasTrustedLabel(record.cluster_label, record.cluster_label_confidence)
      ? record.cluster_label
      : "Unlabelled cluster"
    : null
  const groupLabel = `${record.effective_category} › ${record.subcategory || "General"}`

  const baseClass = compact
    ? "mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"
    : "flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
  const segmentClass = compact
    ? "inline-flex items-center gap-1 truncate max-w-[140px]"
    : "inline-flex items-center gap-1"
  const sepClass = compact
    ? "h-3 w-3 flex-shrink-0 opacity-50"
    : "h-3 w-3 opacity-50"

  return (
    <div className={baseClass}>
      <span className={segmentClass}>
        <Badge variant="outline" className="px-1 py-0 text-[9px] font-mono">A</Badge>
        <span className="truncate">{clusterLabel ?? "no cluster"}</span>
      </span>
      <ChevronRight className={sepClass} />
      <span className={segmentClass}>
        <Badge variant="outline" className="px-1 py-0 text-[9px] font-mono">B</Badge>
        <span className="truncate">{groupLabel}</span>
      </span>
      {!compact && (
        <>
          <ChevronRight className={sepClass} />
          <span className={segmentClass}>
            <Badge variant="outline" className="px-1 py-0 text-[9px] font-mono">C</Badge>
            <span className="font-mono text-[10px]">{record.id.slice(0, 8)}</span>
          </span>
        </>
      )}
    </div>
  )
}

// Inline hints for the selected record when a prerequisite gap or
// validity concern is visible at the row level. Each hint has a
// targeted /admin deep-link so reviewers know exactly which gear to
// turn — generic "something is off" messages train people to ignore
// them. Returns null when there's nothing to flag.
function PerRecordPrereqHints({ record }: { record: ClassificationRecord }) {
  const hints: Array<{ kind: "warn" | "info"; body: React.ReactNode }> = []
  const confidenceDisplay = getConfidenceBandDisplay({
    confidence: record.confidence,
    needsHumanReview: record.effective_needs_human_review,
    retriedWithLargeModel: record.retried_with_large_model,
  })

  // Layer-A miss: this classification's observation has no cluster
  // attachment. Either clustering hasn't caught up, embedding failed,
  // or it's below the cosine threshold. Reviewer can't tell which from
  // here — link to the clustering admin tab where rebuild logs spell
  // it out.
  if (!record.cluster_id) {
    hints.push({
      kind: "info",
      body: (
        <>
          No semantic cluster attached — embedding may be missing or below the similarity
          threshold.{" "}
          <a href="/admin?tab=clustering" className="font-medium text-primary hover:underline">
            Open clustering admin →
          </a>
        </>
      ),
    })
  }

  // Layer-C confidence gate: surface the threshold the schema itself
  // uses (CLASSIFIER_MODEL escalates below 0.7). Below that the LLM
  // already retried with the larger model — knowing this tells the
  // reviewer the result is already best-effort.
  if (record.confidence < 0.7) {
    hints.push({
      kind: "warn",
      body: (
        <>
          {confidenceDisplay.band} — {confidenceDisplay.summary}{" "}
          {record.retried_with_large_model
            ? "already escalated to the large model"
            : "did not escalate to the large model"}
          . {confidenceDisplay.nextAction}{" "}
          <span className="text-muted-foreground">({confidenceDisplay.modelScoreLabel})</span>.
        </>
      ),
    })
  }

  // Surface why the LLM flagged this for human review. The schema's
  // `review_reasons` is an array of free-text reasons populated by the
  // pipeline (low confidence, evidence_quote substring miss, sensitive
  // content, etc.). Showing them inline saves a reviewer from guessing.
  if (record.effective_needs_human_review && record.review_reasons.length > 0) {
    hints.push({
      kind: "warn",
      body: (
        <>
          Flagged for human review:{" "}
          <span className="font-medium">{record.review_reasons.join("; ")}</span>
        </>
      ),
    })
  }

  if (hints.length === 0) return null

  return (
    <div className="space-y-1.5">
      {hints.map((hint, idx) => (
        <div
          key={idx}
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            hint.kind === "warn"
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-border bg-muted/20"
          }`}
        >
          {hint.kind === "warn" ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1 leading-relaxed">{hint.body}</div>
        </div>
      ))}
    </div>
  )
}

// Renders the full LLM-structured Layer-C content for the selected
// record: enums (reproducibility, impact), free-text rationale (root
// cause, suggested fix), evidence quotes (the substrings the LLM cited
// — server-validated by evidenceQuotesAreSubstrings), tags, and
// model/algorithm provenance. Each block is omitted when its source
// field is empty/null so the panel stays terse on minimal classifications.
function ClassificationContextPanel({ record }: { record: ClassificationRecord }) {
  const hasEnums = record.reproducibility || record.impact
  const hasNarrative = record.root_cause_hypothesis || record.suggested_fix
  const hasEvidence = record.evidence_quotes.length > 0
  const hasTags = record.tags.length > 0
  const hasProvenance = record.model_used || record.algorithm_version

  if (!hasEnums && !hasNarrative && !hasEvidence && !hasTags && !hasProvenance) {
    return null
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono">C</Badge>
        <ScrollText className="h-3.5 w-3.5" />
        Classification details
      </p>

      {hasEnums && (
        <div className="grid gap-2 sm:grid-cols-2">
          {record.reproducibility && (
            <ContextField
              icon={<FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />}
              label="Reproducibility"
              value={record.reproducibility}
            />
          )}
          {record.impact && (
            <ContextField
              icon={<AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />}
              label="Impact"
              value={record.impact}
            />
          )}
        </div>
      )}

      {record.root_cause_hypothesis && (
        <div className="space-y-1">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Lightbulb className="h-3.5 w-3.5" /> Root cause hypothesis
          </p>
          <p className="text-sm leading-relaxed">{record.root_cause_hypothesis}</p>
        </div>
      )}

      {record.suggested_fix && (
        <div className="space-y-1">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ArrowRight className="h-3.5 w-3.5" /> Suggested fix
          </p>
          <p className="text-sm leading-relaxed">{record.suggested_fix}</p>
        </div>
      )}

      {hasEvidence && (
        <div className="space-y-1">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Quote className="h-3.5 w-3.5" /> Evidence quotes
            <span className="text-[10px] font-normal opacity-70">(substring-validated against source)</span>
          </p>
          <ul className="space-y-1">
            {record.evidence_quotes.map((quote, idx) => (
              <li
                key={idx}
                className="rounded-md border-l-2 border-primary/40 bg-background px-3 py-1.5 text-xs leading-relaxed text-muted-foreground"
              >
                "{quote}"
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasTags && (
        <div className="space-y-1">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Tag className="h-3.5 w-3.5" /> Tags
          </p>
          <div className="flex flex-wrap gap-1">
            {record.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {hasProvenance && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
          {record.model_used && (
            <span>
              Model: <span className="font-mono text-foreground">{record.model_used}</span>
              {record.retried_with_large_model && (
                <span className="ml-1 text-amber-600">· escalated</span>
              )}
            </span>
          )}
          {record.algorithm_version && (
            <span>
              Algorithm: <span className="font-mono text-foreground">{record.algorithm_version}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ContextField({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-background/50 p-2">
      {icon}
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value}</p>
      </div>
    </div>
  )
}
