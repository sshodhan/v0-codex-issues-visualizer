"use client"

import { useCallback, useEffect, useState } from "react"
import { Download, Loader2, RefreshCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { logClientError } from "@/lib/error-tracking/client-logger"

import type { ClusterQualityBaseline } from "@/lib/cluster-quality/baseline-metrics"

interface BaselineResponse {
  days: number
  sampled_clusters: number
  baseline: ClusterQualityBaseline
}

const DAYS_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "0", label: "All-time" },
] as const

/** Format a 0..1 ratio as "XX.X%" or "—" for null. Snapshot-friendly. */
function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—"
  return `${(v * 100).toFixed(1)}%`
}

function fmtCount(v: number | null | undefined): string {
  if (v == null) return "—"
  return v.toLocaleString()
}

/**
 * Phase 3 cluster-quality baseline panel.
 *
 * Read-only. Surfaces the three primary KPIs (singleton_rate,
 * coherent_cluster_rate, mixed_cluster_rate) plus diagnostic
 * breakdowns. The "Snapshot CSV" button downloads a single CSV row
 * suitable for pasting into the plan doc's Phase 3 baseline table.
 *
 * The KPI cards include a "compare against threshold" hint that maps
 * directly to the Phase 6 / Phase 11 success criteria locked in
 * docs/CLASSIFICATION_EVOLUTION_PLAN.md §3.
 */
export function ClusterQualityBaselinePanel({ secret }: { secret: string }) {
  const [data, setData] = useState<BaselineResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState<string>("30")

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/cluster-quality?days=${days}`, {
        headers: secret ? { "x-admin-secret": secret } : {},
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const payload = (await res.json()) as BaselineResponse
      setData(payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-cluster-quality-load-failed", { days })
    } finally {
      setLoading(false)
    }
  }, [days, secret])

  useEffect(() => {
    if (!secret) return
    void load()
  }, [load, secret])

  const downloadCsv = () => {
    // Hits the route again with ?format=csv. Browsers handle the
    // Content-Disposition header so the file lands in Downloads.
    const url = `/api/admin/cluster-quality?days=${days}&format=csv`
    if (!secret) return
    fetch(url, { headers: { "x-admin-secret": secret } })
      .then((res) => res.blob())
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = objectUrl
        a.download = `cluster-quality-baseline-${new Date().toISOString().slice(0, 10)}.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(objectUrl)
      })
      .catch((e) => {
        logClientError(e, "admin-cluster-quality-csv-failed", { days })
      })
  }

  const baseline = data?.baseline

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Cluster quality baseline</CardTitle>
            <CardDescription>
              Read-only metrics for the current clustering pipeline. Snapshot
              these numbers into the plan doc to lock the baseline before any
              Phase 4/6 behavior change.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={load} disabled={loading || !secret}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={downloadCsv} disabled={!data || !secret}>
              <Download className="mr-2 h-4 w-4" />
              Snapshot CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {!secret && (
          <Alert>
            <AlertTitle>Admin secret required</AlertTitle>
            <AlertDescription>
              Enter the admin secret at the top of this page to load cluster
              quality metrics.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loading && !data && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading baseline…
          </div>
        )}

        {baseline && (
          <>
            {/* Three primary KPI cards. The hint text under each maps */}
            {/* directly to the Phase 6 success thresholds in the plan doc. */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <KpiCard
                label="Singleton rate"
                value={fmtPct(baseline.singleton_rate)}
                hint={`${fmtCount(baseline.singleton_clusters)} of ${fmtCount(baseline.total_clusters)} active clusters. Phase 6 target: drop by ≥ 5pp.`}
                tone={baseline.singleton_rate != null && baseline.singleton_rate >= 0.9 ? "warn" : "neutral"}
              />
              <KpiCard
                label="Coherent cluster rate"
                value={fmtPct(baseline.coherent_cluster_rate)}
                hint={`Of ${fmtCount(baseline.family_classified_count)} family-classified clusters. Phase 6 target: rise by ≥ 3pp.`}
                tone="neutral"
              />
              <KpiCard
                label="Mixed cluster rate"
                value={fmtPct(baseline.mixed_cluster_rate)}
                hint="Multi-member classified clusters with dominant LLM-category share < 50%. Phase 6 no-regress: must NOT rise > 2pp."
                tone={baseline.mixed_cluster_rate != null && baseline.mixed_cluster_rate >= 0.3 ? "warn" : "neutral"}
              />
            </div>

            {/* Secondary stats row — shape of the corpus. */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Total active clusters" value={fmtCount(baseline.total_clusters)} />
              <Stat
                label="semantic: vs title:"
                value={`${fmtPct(baseline.percentages.semantic_share_pct)} / ${fmtPct(baseline.percentages.fallback_share_pct)}`}
              />
              <Stat label="Family classification coverage" value={fmtPct(baseline.family_classification_coverage)} />
              <Stat
                label="Review disagreement"
                value={fmtPct(baseline.review_disagreement_rate)}
              />
            </div>

            {/* Dominant-category share histogram. */}
            <Collapsible defaultOpen>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-start">
                  Dominant LLM-category share — distribution
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <ShareHistogram dist={baseline.dominant_category_share_distribution} />
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Buckets are ≥-semantics: a value at exactly 0.50 lands in the 0.50 bucket, not the 0.00 (mixed)
                  bucket. The 0.00 bucket = the <code className="rounded bg-muted px-1 py-0.5 text-[10px]">mixed_cluster_rate</code> numerator.
                </p>
              </CollapsibleContent>
            </Collapsible>

            {/* Singleton-by-Topic drill. */}
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-start">
                  Singleton rate by Topic
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <RateTable d={baseline.singleton_rate_by_category} />
              </CollapsibleContent>
            </Collapsible>

            {/* Multi-member by Subcategory drill. */}
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-start">
                  Multi-member clusters by LLM subcategory
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <CountTable d={baseline.multi_member_clusters_by_subcategory} />
              </CollapsibleContent>
            </Collapsible>

            {/* Mixed-topic clusters — the "over-merged" finding. */}
            {baseline.top_mixed_topic_clusters.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="w-full justify-start">
                    Top mixed-topic clusters ({baseline.top_mixed_topic_clusters.length})
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cluster ID</TableHead>
                        <TableHead className="text-right">mixed_topic_score</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {baseline.top_mixed_topic_clusters.map((c) => (
                        <TableRow key={c.cluster_id}>
                          <TableCell className="font-mono text-xs">{c.cluster_id}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.mixed_topic_score.toFixed(3)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    From <code className="rounded bg-muted px-1 py-0.5 text-[10px]">mv_cluster_topic_metadata.mixed_topic_score</code>.
                    Higher = more topic spread within the cluster. Worth a manual spot-check
                    to decide if these merges should be split (Stage 5 reviewer feedback).
                  </p>
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint: string
  tone: "neutral" | "warn"
}) {
  const toneClass =
    tone === "warn"
      ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900"
      : "bg-muted/30"
  return (
    <div className={`rounded-md border p-4 ${toneClass}`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
      <p className="mt-2 text-xs leading-tight text-muted-foreground">{hint}</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm tabular-nums">{value}</div>
    </div>
  )
}

function ShareHistogram({ dist }: { dist: Record<string, number> }) {
  const entries = Object.entries(dist).sort((a, b) => Number(a[0]) - Number(b[0]))
  const max = Math.max(1, ...entries.map(([, v]) => v))
  return (
    <div className="space-y-1">
      {entries.map(([lo, count]) => {
        const widthPct = (count / max) * 100
        const isMixed = lo === "0.00"
        const barClass = isMixed ? "bg-amber-500/70" : "bg-primary/70"
        return (
          <div key={lo} className="flex items-center gap-2 text-xs">
            <span className="w-12 font-mono text-muted-foreground tabular-nums">≥ {lo}</span>
            <div className="h-3 flex-1 rounded bg-muted">
              <div className={`h-full rounded ${barClass}`} style={{ width: `${widthPct}%` }} />
            </div>
            <span className="w-12 text-right font-mono tabular-nums">{count}</span>
          </div>
        )
      })}
    </div>
  )
}

function RateTable({ d }: { d: Record<string, number> }) {
  const entries = Object.entries(d).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) {
    return <div className="text-xs text-muted-foreground">No data — possibly no Topic-classified clusters in this window.</div>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Topic</TableHead>
          <TableHead className="text-right">Singleton rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([key, rate]) => (
          <TableRow key={key}>
            <TableCell className="font-mono text-xs">{key}</TableCell>
            <TableCell className="text-right tabular-nums">{(rate * 100).toFixed(1)}%</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function CountTable({ d }: { d: Record<string, number> }) {
  const entries = Object.entries(d).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) {
    return <div className="text-xs text-muted-foreground">No multi-member clusters with classified subcategories in this window.</div>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subcategory</TableHead>
          <TableHead className="text-right">Multi-member clusters</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([key, count]) => (
          <TableRow key={key}>
            <TableCell className="font-mono text-xs">{key}</TableCell>
            <TableCell className="text-right tabular-nums">{count.toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
