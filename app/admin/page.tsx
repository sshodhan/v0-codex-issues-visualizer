"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  Loader2,
  Play,
  RefreshCw,
  Square,
  TestTube2,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { logClientError } from "@/lib/error-tracking/client-logger"
import type {
  CheckResult,
  VerifyReport,
} from "@/lib/schema/expected-manifest"

const CHUNK_SIZE = 500

type Kind = "sentiment" | "category" | "impact" | "competitor_mention"

interface Versions {
  sentiment: string
  category: string
  impact: string
  competitor_mention: string
  classification: string
}

interface BackfillStats {
  totalObservations: number
  versions: Versions
}

interface WriteCounts {
  sentiment: number
  category: number
  impact: number
  competitor_mention: number
}

interface SampleDiff {
  observation_id: string
  title: string
  computed: {
    sentiment: { label: string; score: number; keyword_presence: number }
    category_slug: string | null
    impact: number
    competitors: string[]
  }
}

interface ClusterStats {
  observations: number
  clusters: number
  active_memberships: number
  orphans: number
  top_clusters: Array<{
    cluster_id: string
    cluster_key: string
    canonical_title: string
    frequency_count: number
  }>
}

interface SampleKey {
  id: string
  title: string
  cluster_key: string
}

interface ClassifyBackfillStats {
  pendingCandidates: number
  defaultLimit: number
  maxLimit: number
  minImpactScore: number
  openaiConfigured: boolean
}

interface ClassifyBackfillFailure {
  observationId: string
  title: string
  reason: string
}

interface ClassifyBackfillBatchResult {
  dryRun: boolean
  candidates: number
  classified: number
  skipped: number
  failed: number
  failures: ClassifyBackfillFailure[]
  refreshedMvs: boolean
}

export default function AdminPage() {
  const [secret, setSecret] = useState("")

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="container mx-auto flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Dashboard
            </Link>
            <div className="h-6 w-px bg-border" />
            <h1 className="text-lg font-semibold">Admin</h1>
          </div>
          <div className="flex items-center gap-2">
            <label
              htmlFor="admin-secret"
              className="text-xs text-muted-foreground"
            >
              x-admin-secret
            </label>
            <Input
              id="admin-secret"
              type="password"
              placeholder="optional"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="h-8 w-64 text-sm"
            />
          </div>
        </div>
      </header>

      <main className="container mx-auto space-y-6 py-6">
        <Tabs defaultValue="backfill" className="space-y-4">
          <TabsList>
            <TabsTrigger value="backfill">Backfill</TabsTrigger>
            <TabsTrigger value="classify-backfill">Classify backfill</TabsTrigger>
            <TabsTrigger value="clustering">Clustering</TabsTrigger>
            <TabsTrigger value="schema">Schema verification</TabsTrigger>
          </TabsList>
          <TabsContent value="backfill">
            <BackfillPanel secret={secret} />
          </TabsContent>
          <TabsContent value="classify-backfill">
            <ClassifyBackfillPanel secret={secret} />
          </TabsContent>
          <TabsContent value="clustering">
            <ClusteringPanel secret={secret} />
          </TabsContent>
          <TabsContent value="schema">
            <SchemaVerificationPanel secret={secret} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

function authHeaders(secret: string): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" }
  if (secret) h["x-admin-secret"] = secret
  return h
}

// Map failed admin responses to operator-friendly text. 401 and 503 are
// the secret-config failure modes that benefit the most from plain words
// pointing at the header input.
async function explainAdminFailure(res: Response): Promise<string> {
  if (res.status === 401) {
    return "Admin secret required — paste it in the x-admin-secret field above."
  }
  if (res.status === 503) {
    return "ADMIN_SECRET is not configured on the server. Set the env var and redeploy."
  }
  let body = ""
  try {
    body = (await res.text()).slice(0, 200)
  } catch {
    // ignore
  }
  return body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`
}

// ============================================================================
// Backfill panel
// ============================================================================

function BackfillPanel({ secret }: { secret: string }) {
  const [stats, setStats] = useState<BackfillStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const [running, setRunning] = useState<null | "dryRun" | "apply">(null)
  const [processed, setProcessed] = useState(0)
  const [writes, setWrites] = useState<WriteCounts>({
    sentiment: 0,
    category: 0,
    impact: 0,
    competitor_mention: 0,
  })
  const [samples, setSamples] = useState<SampleDiff[]>([])
  const [runError, setRunError] = useState<string | null>(null)
  const [refreshedMvs, setRefreshedMvs] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const loadStats = async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const res = await fetch("/api/admin/backfill-derivations", {
        headers: authHeaders(secret),
      })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as BackfillStats
      setStats(data)
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-backfill-stats-failed")
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret])

  const run = async (dryRun: boolean) => {
    if (running) return
    setRunning(dryRun ? "dryRun" : "apply")
    setProcessed(0)
    setWrites({ sentiment: 0, category: 0, impact: 0, competitor_mention: 0 })
    setSamples([])
    setRunError(null)
    setRefreshedMvs(false)

    const abort = new AbortController()
    abortRef.current = abort
    let cursor: string | null = null
    let seenSamples = false

    try {
      while (!abort.signal.aborted) {
        const res = await fetch("/api/admin/backfill-derivations", {
          method: "POST",
          signal: abort.signal,
          headers: authHeaders(secret),
          body: JSON.stringify({ cursor, limit: CHUNK_SIZE, dryRun }),
        })
        if (!res.ok) {
          throw new Error(await explainAdminFailure(res))
        }
        const data = await res.json()
        setProcessed((p) => p + (data.processed as number))
        setWrites((w) => ({
          sentiment: w.sentiment + (data.writes?.sentiment ?? 0),
          category: w.category + (data.writes?.category ?? 0),
          impact: w.impact + (data.writes?.impact ?? 0),
          competitor_mention:
            w.competitor_mention + (data.writes?.competitor_mention ?? 0),
        }))
        if (!seenSamples && Array.isArray(data.sampleDiffs) && data.sampleDiffs.length) {
          setSamples(data.sampleDiffs)
          seenSamples = true
        }
        if (data.refreshedMvs) setRefreshedMvs(true)
        cursor = data.nextCursor ?? null
        if (data.done) break
      }
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setRunError(e instanceof Error ? e.message : String(e))
        logClientError(e, "admin-backfill-run-failed", { dryRun })
      }
    } finally {
      abortRef.current = null
      setRunning(null)
      await loadStats()
    }
  }

  const abort = () => abortRef.current?.abort()

  const pct =
    stats && stats.totalObservations > 0
      ? Math.min(100, (processed / stats.totalObservations) * 100)
      : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Backfill derivations (Option C)</CardTitle>
            <CardDescription>
              Walks every observation and writes v2 sentiment / category /
              impact / competitor-mention rows alongside existing v1 rows.
              Append-only and idempotent — safe to re-run.
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadStats}
            disabled={statsLoading || running !== null}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${statsLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {statsError && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load stats</AlertTitle>
            <AlertDescription>{statsError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="text-xs text-muted-foreground">
              Total observations
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {stats ? stats.totalObservations.toLocaleString() : "—"}
            </div>
          </div>
          {stats && (
            <div className="flex flex-wrap gap-2">
              {(
                [
                  "sentiment",
                  "category",
                  "impact",
                  "competitor_mention",
                  "classification",
                ] as const
              ).map((k) => (
                <Badge key={k} variant="secondary" className="font-mono">
                  {k}: {stats.versions[k]}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => run(true)}
            disabled={running !== null}
          >
            {running === "dryRun" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <TestTube2 className="mr-2 h-4 w-4" />
            )}
            Dry run
          </Button>
          <Button
            onClick={() => run(false)}
            disabled={running !== null}
          >
            {running === "apply" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Apply
          </Button>
          {running && (
            <Button variant="destructive" onClick={abort}>
              <Square className="mr-2 h-4 w-4" />
              Abort
            </Button>
          )}
        </div>

        {(running || processed > 0) && (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {processed.toLocaleString()} /{" "}
                  {stats?.totalObservations.toLocaleString() ?? "?"} observations
                </span>
                <span className="tabular-nums">{pct.toFixed(1)}%</span>
              </div>
              <Progress value={pct} />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ["sentiment", writes.sentiment],
                  ["category", writes.category],
                  ["impact", writes.impact],
                  ["competitor_mention", writes.competitor_mention],
                ] as Array<[Kind, number]>
              ).map(([k, v]) => (
                <div key={k} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{k}</div>
                  <div className="font-mono text-lg tabular-nums">
                    {v.toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {runError && (
          <Alert variant="destructive">
            <AlertTitle>Run failed</AlertTitle>
            <AlertDescription>{runError}</AlertDescription>
          </Alert>
        )}

        {refreshedMvs && running === null && (
          <Alert>
            <AlertTitle>Dashboard refreshed</AlertTitle>
            <AlertDescription>
              mv_observation_current and mv_trend_daily have been rebuilt.
              The dashboard now reads the current-version derivations.
            </AlertDescription>
          </Alert>
        )}

        {samples.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                Sample diffs ({samples.length})
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Sentiment</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Impact</TableHead>
                      <TableHead>Competitors</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {samples.map((s) => (
                      <TableRow key={s.observation_id}>
                        <TableCell className="max-w-[320px] truncate" title={s.title}>
                          {s.title}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              s.computed.sentiment.label === "negative"
                                ? "destructive"
                                : s.computed.sentiment.label === "positive"
                                  ? "default"
                                  : "secondary"
                            }
                          >
                            {s.computed.sentiment.label}{" "}
                            {s.computed.sentiment.score.toFixed(2)}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {s.computed.category_slug ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {s.computed.impact}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {s.computed.competitors.length === 0
                            ? "—"
                            : s.computed.competitors.join(", ")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Clustering panel
// ============================================================================

function ClusteringPanel({ secret }: { secret: string }) {
  const [stats, setStats] = useState<ClusterStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const [redetach, setRedetach] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [processed, setProcessed] = useState(0)
  const [attached, setAttached] = useState(0)
  const [detached, setDetached] = useState(0)
  const [sampleKeys, setSampleKeys] = useState<SampleKey[]>([])
  const [runError, setRunError] = useState<string | null>(null)
  const [refreshedMvs, setRefreshedMvs] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const loadStats = async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const res = await fetch("/api/admin/cluster", {
        headers: authHeaders(secret),
      })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as ClusterStats
      setStats(data)
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-cluster-stats-failed")
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret])

  const handleRebuildClick = () => {
    if (running) return
    if (redetach) {
      setConfirmOpen(true)
      return
    }
    void runRebuild()
  }

  const runRebuild = async () => {
    setConfirmOpen(false)
    setRunning(true)
    setProcessed(0)
    setAttached(0)
    setDetached(0)
    setSampleKeys([])
    setRunError(null)
    setRefreshedMvs(false)

    const abort = new AbortController()
    abortRef.current = abort
    let cursor: string | null = null
    let seenSamples = false

    try {
      while (!abort.signal.aborted) {
        const res = await fetch("/api/admin/cluster", {
          method: "POST",
          signal: abort.signal,
          headers: authHeaders(secret),
          body: JSON.stringify({
            action: "rebuild",
            cursor,
            limit: CHUNK_SIZE,
            redetach,
          }),
        })
        if (!res.ok) {
          throw new Error(await explainAdminFailure(res))
        }
        const data = await res.json()
        setProcessed((p) => p + (data.processed as number))
        setAttached((a) => a + (data.attached ?? 0))
        if (typeof data.detached === "number") {
          setDetached((d) => d + data.detached)
        }
        if (!seenSamples && Array.isArray(data.sampleKeys) && data.sampleKeys.length) {
          setSampleKeys(data.sampleKeys)
          seenSamples = true
        }
        if (data.refreshedMvs) setRefreshedMvs(true)
        cursor = data.nextCursor ?? null
        if (data.done) break
      }
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setRunError(e instanceof Error ? e.message : String(e))
        logClientError(e, "admin-cluster-rebuild-failed", { redetach })
      }
    } finally {
      abortRef.current = null
      setRunning(false)
      await loadStats()
    }
  }

  const abort = () => abortRef.current?.abort()

  const pct =
    stats && stats.observations > 0
      ? Math.min(100, (processed / stats.observations) * 100)
      : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Clustering</CardTitle>
            <CardDescription>
              Live stats and on-demand rebuild. Attach-only mode is a no-op
              for already-clustered observations (safe to re-run). Re-detach
              mode is only for when buildClusterKey itself has changed.
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadStats}
            disabled={statsLoading || running}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${statsLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {statsError && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load stats</AlertTitle>
            <AlertDescription>{statsError}</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ["Observations", stats?.observations],
              ["Clusters", stats?.clusters],
              ["Active memberships", stats?.active_memberships],
              ["Orphans", stats?.orphans],
            ] as Array<[string, number | undefined]>
          ).map(([label, value]) => (
            <div key={label} className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-xl font-semibold tabular-nums">
                {value != null ? value.toLocaleString() : "—"}
              </div>
            </div>
          ))}
        </div>

        {stats && stats.top_clusters.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                Top {stats.top_clusters.length} clusters by frequency
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cluster key</TableHead>
                      <TableHead>Canonical title</TableHead>
                      <TableHead className="text-right">Frequency</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.top_clusters.map((c) => (
                      <TableRow key={c.cluster_id}>
                        <TableCell className="font-mono text-xs">
                          {c.cluster_key}
                        </TableCell>
                        <TableCell
                          className="max-w-[420px] truncate"
                          title={c.canonical_title}
                        >
                          {c.canonical_title}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.frequency_count}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="redetach"
              checked={redetach}
              onCheckedChange={(c) => setRedetach(c === true)}
              disabled={running}
            />
            <label
              htmlFor="redetach"
              className="cursor-pointer text-sm text-muted-foreground"
            >
              Re-detach first (only when buildClusterKey changed)
            </label>
          </div>
          <Button onClick={handleRebuildClick} disabled={running}>
            {running ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Rebuild clusters
          </Button>
          {running && (
            <Button variant="destructive" onClick={abort}>
              <Square className="mr-2 h-4 w-4" />
              Abort
            </Button>
          )}
        </div>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Re-detach every active membership?</AlertDialogTitle>
              <AlertDialogDescription>
                This clears current cluster membership for every observation
                during the run. Dashboards that read cluster_id or
                frequency_count will show inconsistent state until the rebuild
                completes. Only use when the buildClusterKey function itself
                has changed — attach-only rebuild is safe in all other cases.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void runRebuild()}
              >
                Re-detach and rebuild
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {(running || processed > 0) && (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {processed.toLocaleString()} /{" "}
                  {stats?.observations.toLocaleString() ?? "?"} observations
                </span>
                <span className="tabular-nums">{pct.toFixed(1)}%</span>
              </div>
              <Progress value={pct} />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Processed</div>
                <div className="font-mono text-lg tabular-nums">
                  {processed.toLocaleString()}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Attached</div>
                <div className="font-mono text-lg tabular-nums">
                  {attached.toLocaleString()}
                </div>
              </div>
              {redetach && (
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Detached</div>
                  <div className="font-mono text-lg tabular-nums">
                    {detached.toLocaleString()}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {runError && (
          <Alert variant="destructive">
            <AlertTitle>Rebuild failed</AlertTitle>
            <AlertDescription>{runError}</AlertDescription>
          </Alert>
        )}

        {refreshedMvs && !running && (
          <Alert>
            <AlertTitle>Dashboard refreshed</AlertTitle>
            <AlertDescription>
              mv_observation_current and mv_trend_daily have been rebuilt.
              Cluster assignments on the dashboard now reflect this rebuild.
            </AlertDescription>
          </Alert>
        )}

        {sampleKeys.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                Sample cluster keys ({sampleKeys.length})
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Cluster key</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sampleKeys.map((k) => (
                      <TableRow key={k.id}>
                        <TableCell
                          className="max-w-[520px] truncate"
                          title={k.title}
                        >
                          {k.title}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {k.cluster_key}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Classify-backfill panel (LLM — BUGS.md N-10)
// ============================================================================

// Daily cron caps at 10 obs/run — right for steady-state, wrong for an
// initial backlog (10k rows ≈ 3 years at that rate). This panel's
// "Run until done" loop is the catch-up path: it pages through
// /api/admin/classify-backfill until pending reaches 0. Budget is
// ~$0.04 per observation at gpt-5-mini rates, so a 1k backlog is ~$40.
function ClassifyBackfillPanel({ secret }: { secret: string }) {
  const [stats, setStats] = useState<ClassifyBackfillStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const [limit, setLimit] = useState(10)
  const [running, setRunning] = useState<null | "dryRun" | "batch" | "loop">(null)
  const [dryRunPreview, setDryRunPreview] =
    useState<{ pendingCandidates: number; wouldProcess: number } | null>(null)
  const [lastBatch, setLastBatch] = useState<ClassifyBackfillBatchResult | null>(
    null,
  )
  const [loopTotals, setLoopTotals] = useState({
    classified: 0,
    skipped: 0,
    failed: 0,
    batches: 0,
  })
  const [failures, setFailures] = useState<ClassifyBackfillFailure[]>([])
  const [runError, setRunError] = useState<string | null>(null)
  const [refreshedMvs, setRefreshedMvs] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const loadStats = async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const res = await fetch("/api/admin/classify-backfill", {
        headers: authHeaders(secret),
      })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as ClassifyBackfillStats
      setStats(data)
      setLimit((current) =>
        current === 10 || !Number.isFinite(current) ? data.defaultLimit : current,
      )
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-classify-backfill-stats-failed")
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret])

  const resetBeforeRun = () => {
    setDryRunPreview(null)
    setLastBatch(null)
    setFailures([])
    setLoopTotals({ classified: 0, skipped: 0, failed: 0, batches: 0 })
    setRunError(null)
    setRefreshedMvs(false)
  }

  const runDryRun = async () => {
    if (running) return
    setRunning("dryRun")
    resetBeforeRun()
    try {
      const res = await fetch("/api/admin/classify-backfill", {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ dryRun: true, limit }),
      })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as {
        pendingCandidates: number
        wouldProcess: number
      }
      setDryRunPreview({
        pendingCandidates: data.pendingCandidates,
        wouldProcess: data.wouldProcess,
      })
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-classify-backfill-dryrun-failed")
    } finally {
      setRunning(null)
    }
  }

  const runOneBatch = async () => {
    if (running) return
    setRunning("batch")
    resetBeforeRun()
    try {
      const res = await fetch("/api/admin/classify-backfill", {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ limit }),
      })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as ClassifyBackfillBatchResult
      setLastBatch(data)
      setFailures(data.failures ?? [])
      setRefreshedMvs(data.refreshedMvs)
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-classify-backfill-batch-failed")
    } finally {
      setRunning(null)
      await loadStats()
    }
  }

  const runUntilDone = async () => {
    if (running) return
    setRunning("loop")
    resetBeforeRun()

    const abort = new AbortController()
    abortRef.current = abort
    let consecutiveErrors = 0
    const collectedFailures: ClassifyBackfillFailure[] = []
    let finalRefreshedMvs = false

    try {
      // Use the stats count as an upper bound on iterations so a
      // pathological server always-returns-nonzero bug can't run
      // forever. /ceil(limit, pending) + slack is generous.
      let safetyIterations = stats
        ? Math.ceil(stats.pendingCandidates / Math.max(1, limit)) + 5
        : 200

      while (!abort.signal.aborted && safetyIterations-- > 0) {
        // Last known pending count: once we've processed a batch we
        // use the previous batch's candidates to infer when to set
        // refreshMvs=true. Simpler heuristic: request count before
        // firing each batch; refresh when it's the final non-empty
        // batch.
        const pendingRes = await fetch("/api/admin/classify-backfill", {
          method: "POST",
          signal: abort.signal,
          headers: authHeaders(secret),
          body: JSON.stringify({ dryRun: true, limit }),
        })
        if (!pendingRes.ok) {
          throw new Error(await explainAdminFailure(pendingRes))
        }
        const pendingData = (await pendingRes.json()) as {
          pendingCandidates: number
        }
        if (pendingData.pendingCandidates === 0) break

        const isFinalBatch = pendingData.pendingCandidates <= limit

        const res = await fetch("/api/admin/classify-backfill", {
          method: "POST",
          signal: abort.signal,
          headers: authHeaders(secret),
          body: JSON.stringify({ limit, refreshMvs: isFinalBatch }),
        })
        if (!res.ok) {
          consecutiveErrors += 1
          const msg = await explainAdminFailure(res)
          if (consecutiveErrors >= 3) {
            throw new Error(`Aborted after 3 consecutive errors: ${msg}`)
          }
          await new Promise((r) => setTimeout(r, 1000 * consecutiveErrors))
          continue
        }
        consecutiveErrors = 0
        const data = (await res.json()) as ClassifyBackfillBatchResult
        setLastBatch(data)
        setLoopTotals((t) => ({
          classified: t.classified + data.classified,
          skipped: t.skipped + data.skipped,
          failed: t.failed + data.failed,
          batches: t.batches + 1,
        }))
        if (data.failures?.length) {
          collectedFailures.push(...data.failures)
          setFailures([...collectedFailures])
        }
        if (data.refreshedMvs) finalRefreshedMvs = true

        // No-op batch means everything this round was already
        // classified; nothing to page further.
        if (data.candidates === 0) break

        // Spacing keeps rate-limit clusters at bay between batches.
        await new Promise((r) => setTimeout(r, 500))
      }
      setRefreshedMvs(finalRefreshedMvs)
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setRunError(e instanceof Error ? e.message : String(e))
        logClientError(e, "admin-classify-backfill-loop-failed")
      }
    } finally {
      abortRef.current = null
      setRunning(null)
      await loadStats()
    }
  }

  const abort = () => abortRef.current?.abort()

  const openaiOk = stats?.openaiConfigured ?? false

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Classify backfill (LLM)</CardTitle>
            <CardDescription>
              Routes high-impact unclassified canonical observations through
              the LLM pipeline. Each run is capped to fit Vercel&apos;s 60s
              function limit; loop until &quot;pending&quot; reaches 0 to clear
              a backlog. Costs ~$0.04 per observation at gpt-5-mini rates. On
              Hobby keep per-batch limit ≤ 15 so ~3-5s/call stays under the
              timeout. Avoid running while the 03:00 UTC cron tick may be
              active — overlapping runs can race on the dedupe check (BUGS.md
              N-9).
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadStats}
            disabled={statsLoading || running !== null}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${statsLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {statsError && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load stats</AlertTitle>
            <AlertDescription>{statsError}</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">
              Pending candidates
            </div>
            <div className="text-xl font-semibold tabular-nums">
              {stats ? stats.pendingCandidates.toLocaleString() : "—"}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">Default limit</div>
            <div className="text-xl font-semibold tabular-nums">
              {stats ? stats.defaultLimit : "—"}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">
              Min impact score
            </div>
            <div className="text-xl font-semibold tabular-nums">
              {stats ? stats.minImpactScore : "—"}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">OpenAI key</div>
            <div className="text-xl font-semibold">
              {stats ? (openaiOk ? "configured" : "missing") : "—"}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="classify-limit"
              className="mb-1 block text-xs text-muted-foreground"
            >
              Batch limit
            </label>
            <Input
              id="classify-limit"
              type="number"
              min={1}
              max={stats?.maxLimit ?? 100}
              value={limit}
              onChange={(e) => {
                const next = Number(e.target.value)
                if (Number.isFinite(next)) {
                  setLimit(
                    Math.max(1, Math.min(next, stats?.maxLimit ?? 100)),
                  )
                }
              }}
              className="h-9 w-24"
              disabled={running !== null}
            />
          </div>
          <Button
            variant="outline"
            onClick={runDryRun}
            disabled={running !== null}
          >
            {running === "dryRun" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <TestTube2 className="mr-2 h-4 w-4" />
            )}
            Dry run
          </Button>
          <Button
            onClick={runOneBatch}
            disabled={running !== null || !openaiOk}
          >
            {running === "batch" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Run one batch
          </Button>
          <Button
            variant="default"
            onClick={runUntilDone}
            disabled={running !== null || !openaiOk}
          >
            {running === "loop" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Run until done
          </Button>
          {running === "loop" && (
            <Button variant="destructive" onClick={abort}>
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>
          )}
        </div>

        {dryRunPreview && (
          <Alert>
            <AlertTitle>Dry run preview</AlertTitle>
            <AlertDescription>
              {dryRunPreview.pendingCandidates.toLocaleString()} pending
              candidate
              {dryRunPreview.pendingCandidates === 1 ? "" : "s"}. The next
              batch would process{" "}
              {dryRunPreview.wouldProcess.toLocaleString()} at the current
              limit. No tokens spent.
            </AlertDescription>
          </Alert>
        )}

        {lastBatch && running !== "loop" && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Candidates</div>
              <div className="font-mono text-lg tabular-nums">
                {lastBatch.candidates.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Classified</div>
              <div className="font-mono text-lg tabular-nums">
                {lastBatch.classified.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Skipped</div>
              <div className="font-mono text-lg tabular-nums">
                {lastBatch.skipped.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Failed</div>
              <div className="font-mono text-lg tabular-nums">
                {lastBatch.failed.toLocaleString()}
              </div>
            </div>
          </div>
        )}

        {(running === "loop" || loopTotals.batches > 0) && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Batches</div>
              <div className="font-mono text-lg tabular-nums">
                {loopTotals.batches.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">
                Total classified
              </div>
              <div className="font-mono text-lg tabular-nums">
                {loopTotals.classified.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total skipped</div>
              <div className="font-mono text-lg tabular-nums">
                {loopTotals.skipped.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total failed</div>
              <div className="font-mono text-lg tabular-nums">
                {loopTotals.failed.toLocaleString()}
              </div>
            </div>
          </div>
        )}

        {runError && (
          <Alert variant="destructive">
            <AlertTitle>Run failed</AlertTitle>
            <AlertDescription>{runError}</AlertDescription>
          </Alert>
        )}

        {refreshedMvs && running === null && (
          <Alert>
            <AlertTitle>Dashboard refreshed</AlertTitle>
            <AlertDescription>
              mv_observation_current has been rebuilt. The AI Classifications
              tab now reflects the new rows.
            </AlertDescription>
          </Alert>
        )}

        {stats && stats.pendingCandidates === 0 && running === null && (
          <Alert>
            <AlertTitle>All caught up</AlertTitle>
            <AlertDescription>
              0 pending. No high-impact canonical observations currently need
              classification.
            </AlertDescription>
          </Alert>
        )}

        {failures.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                Failures ({failures.length})
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Observation</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {failures.map((f) => (
                      <TableRow key={f.observationId}>
                        <TableCell className="font-mono text-xs">
                          {f.observationId}
                        </TableCell>
                        <TableCell
                          className="max-w-[320px] truncate"
                          title={f.title}
                        >
                          {f.title}
                        </TableCell>
                        <TableCell
                          className="max-w-[360px] truncate text-xs text-muted-foreground"
                          title={f.reason}
                        >
                          {f.reason}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Schema verification panel
// ============================================================================

type CheckWithHint = CheckResult & { hint?: string }

function SchemaVerificationPanel({ secret }: { secret: string }) {
  const [report, setReport] = useState<VerifyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showPassing, setShowPassing] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/verify-schema", {
        headers: authHeaders(secret),
      })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as VerifyReport
      setReport(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-verify-schema-failed")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret])

  const grouped = report ? groupChecks(report.checks) : []
  const failingCount = report?.summary.fail ?? 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Schema verification</CardTitle>
            <CardDescription>
              Compares the live <code>public</code> schema against the
              expected post-014 manifest. Reports per-object pass/fail
              for tables, views, materialized views, indexes, functions,
              required columns, dropped objects, and the
              algorithm-version registry.
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
            Re-check
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Failed to verify schema</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {report && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Total checks</div>
                <div className="text-2xl font-semibold tabular-nums">
                  {report.summary.total}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Passing</div>
                <div className="text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {report.summary.pass}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Failing</div>
                <div
                  className={`text-2xl font-semibold tabular-nums ${
                    failingCount > 0
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                >
                  {failingCount}
                </div>
              </div>
              <div className="ml-auto text-xs text-muted-foreground">
                Snapshot:{" "}
                <span className="font-mono">
                  {new Date(report.snapshotAt).toLocaleString()}
                </span>
              </div>
            </div>

            {failingCount === 0 ? (
              <Alert>
                <AlertTitle>All schema objects accounted for</AlertTitle>
                <AlertDescription>
                  Every expected table, view, MV, index, function, column,
                  and algorithm-version row matched the manifest. Nothing
                  forbidden is present.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <AlertTitle>{failingCount} check(s) failing</AlertTitle>
                <AlertDescription>
                  Drift between live schema and the post-014 manifest.
                  Apply the missing migration(s) — see{" "}
                  <code>scripts/</code> — and re-check.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex items-center gap-2">
              <Checkbox
                id="show-passing"
                checked={showPassing}
                onCheckedChange={(c) => setShowPassing(c === true)}
              />
              <label
                htmlFor="show-passing"
                className="cursor-pointer text-sm text-muted-foreground"
              >
                Show passing checks
              </label>
            </div>

            <div className="space-y-4">
              {grouped.map(([group, checks]) => {
                const groupFails = checks.filter((c) => c.status === "fail")
                const visible = showPassing ? checks : groupFails
                if (visible.length === 0) return null
                return (
                  <div key={group} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold capitalize">
                        {group}
                      </h3>
                      <Badge variant="secondary" className="font-mono">
                        {checks.length - groupFails.length}/{checks.length}{" "}
                        passing
                      </Badge>
                    </div>
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[140px]">Status</TableHead>
                            <TableHead className="w-[100px]">Kind</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Expected</TableHead>
                            <TableHead>Actual</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visible.map((c, i) => (
                            <TableRow key={`${c.kind}-${c.name}-${i}`}>
                              <TableCell>
                                <Badge
                                  variant={
                                    c.status === "pass"
                                      ? "default"
                                      : "destructive"
                                  }
                                >
                                  {c.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {c.kind}
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {c.name}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {c.expected}
                              </TableCell>
                              <TableCell className="text-xs">
                                {c.actual}
                                {(c as CheckWithHint).hint && (
                                  <div className="mt-1 text-muted-foreground">
                                    {(c as CheckWithHint).hint}
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// Stable group ordering keeps the report scannable: failures cluster by
// architectural layer instead of jumping kind-to-kind.
const GROUP_ORDER = [
  "verifier",
  "reference",
  "evidence",
  "derivation",
  "classification",
  "clustering",
  "fingerprints",
  "aggregation",
  "algorithm",
  "dropped",
  "other",
]

function groupChecks(checks: CheckResult[]): Array<[string, CheckResult[]]> {
  const map = new Map<string, CheckResult[]>()
  for (const c of checks) {
    const g = c.group ?? "other"
    const arr = map.get(g) ?? []
    arr.push(c)
    map.set(g, arr)
  }
  const ordered: Array<[string, CheckResult[]]> = []
  for (const g of GROUP_ORDER) {
    const arr = map.get(g)
    if (arr) ordered.push([g, arr])
  }
  for (const [g, arr] of map) {
    if (!GROUP_ORDER.includes(g)) ordered.push([g, arr])
  }
  return ordered
}
