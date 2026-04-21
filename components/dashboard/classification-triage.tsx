"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react"
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
import { formatDistanceToNow, subDays } from "date-fns"
import type { ClassificationRecord, ClassificationStats } from "@/hooks/use-dashboard-data"
import { reviewClassification } from "@/hooks/use-dashboard-data"

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

  const globallyFilteredRecords = useMemo(() => {
    const timeCutoff = timeDays > 0 ? subDays(new Date(), timeDays) : null

    return records.filter((record) => {
      const categoryMatch = activeCategory === "all" || record.category.toLowerCase() === activeCategory
      const timeMatch = !timeCutoff || new Date(record.created_at) >= timeCutoff
      return categoryMatch && timeMatch
    })
  }, [records, activeCategory, timeDays])

  const clusters = useMemo(() => {
    const grouped = new Map<string, { total: number; highRisk: number }>()
    for (const record of globallyFilteredRecords) {
      const key = `${record.category} › ${record.subcategory || "General"}`
      const current = grouped.get(key) || { total: 0, highRisk: 0 }
      current.total += 1
      if (record.severity === "critical" || record.severity === "high") current.highRisk += 1
      grouped.set(key, current)
    }

    return Array.from(grouped.entries())
      .map(([name, values]) => ({ name, ...values }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
  }, [globallyFilteredRecords])

  const triageRecords = useMemo(() => {
    if (clusterFilter === "all") return globallyFilteredRecords
    return globallyFilteredRecords.filter((record) => `${record.category} › ${record.subcategory || "General"}` === clusterFilter)
  }, [globallyFilteredRecords, clusterFilter])

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

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Top classification clusters</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={clusterFilter === "all" ? "default" : "outline"} onClick={() => setClusterFilter("all")}>
              All clusters
            </Button>
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
        ) : triageRecords.length === 0 ? (
          <p className="text-sm text-muted-foreground">No classifier records in this scope. Adjust global sliders or cluster filter.</p>
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
                      setStatusOverride(record.status)
                      setSeverityOverride(record.severity)
                      setCategoryOverride(record.category)
                    }}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {record.needs_human_review && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                        <span>{record.category}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{record.subcategory}</p>
                    </TableCell>
                    <TableCell><Badge variant="outline">{record.severity}</Badge></TableCell>
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
                    <TableCell>{record.status}</TableCell>
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
              <Input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Reviewer name/email" />
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
