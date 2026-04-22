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
import { logClientError } from "@/lib/error-tracking/client-logger"

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
        <BackfillPanel secret={secret} />
        <ClusteringPanel secret={secret} />
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
