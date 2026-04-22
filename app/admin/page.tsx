"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertTriangle, ArrowLeft, CheckCircle2, Database, GitMerge, Loader2, Play, RefreshCw } from "lucide-react"

// Admin page: triggers the long-running Option C backfill and cluster
// maintenance from the browser. Both operations are chunked behind the
// Vercel maxDuration cap — the page polls the API in a loop until the
// server responds done=true.
//
// Auth: if ADMIN_SECRET is set on the deploy, the API rejects requests
// without the matching x-admin-secret header. This page has a text input
// for the secret; it is stored only in local React state (never persisted).

type Versions = Record<string, string>

interface BackfillStats {
  totalObservations: number
  versions: Versions
}

interface BackfillResponse {
  processed: number
  writes: { sentiment: number; category: number; impact: number; competitor_mention: number }
  nextCursor: string | null
  done: boolean
  dryRun: boolean
  versions: Versions
  sampleDiffs?: Array<{
    id: string
    title: string
    sentiment: string
    category_slug?: string
    impact: number
    competitors: string[]
  }>
}

interface ClusterStats {
  observations: number
  clusters: number
  active_memberships: number
  orphans: number
  top_clusters: Array<{
    cluster_id: string | null
    cluster_key: string | null
    canonical_title: string | null
    frequency: number
  }>
}

interface ClusterRebuildResponse {
  processed: number
  attached: number
  detached?: number
  nextCursor: string | null
  done: boolean
  sampleKeys?: Array<{ id: string; title: string; cluster_key: string }>
}

function useAdminSecret() {
  const [secret, setSecret] = useState("")
  const headers = useCallback(
    (extra: HeadersInit = {}): HeadersInit =>
      secret ? { ...extra, "x-admin-secret": secret } : extra,
    [secret],
  )
  return { secret, setSecret, headers }
}

function BackfillPanel({ headers }: { headers: (extra?: HeadersInit) => HeadersInit }) {
  const [stats, setStats] = useState<BackfillStats | null>(null)
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<"idle" | "dry-run" | "apply">("idle")
  const [processed, setProcessed] = useState(0)
  const [writes, setWrites] = useState({ sentiment: 0, category: 0, impact: 0, competitor_mention: 0 })
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const [samples, setSamples] = useState<BackfillResponse["sampleDiffs"]>([])
  const abortRef = useRef(false)

  const loadStats = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch("/api/admin/backfill-derivations", { headers: headers({}) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStats(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [headers])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const run = useCallback(
    async (dryRun: boolean) => {
      setRunning(true)
      setMode(dryRun ? "dry-run" : "apply")
      setError(null)
      setProcessed(0)
      setWrites({ sentiment: 0, category: 0, impact: 0, competitor_mention: 0 })
      setCursor(null)
      setCompleted(false)
      setSamples([])
      abortRef.current = false

      let nextCursor: string | null = null
      let totalProcessed = 0
      const rolling = { sentiment: 0, category: 0, impact: 0, competitor_mention: 0 }

      try {
        while (!abortRef.current) {
          const res: Response = await fetch("/api/admin/backfill-derivations", {
            method: "POST",
            headers: headers({ "Content-Type": "application/json" }),
            body: JSON.stringify({ cursor: nextCursor, limit: 500, dryRun }),
          })
          if (!res.ok) {
            const text = await res.text()
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
          }
          const data: BackfillResponse = await res.json()
          totalProcessed += data.processed
          rolling.sentiment += data.writes.sentiment
          rolling.category += data.writes.category
          rolling.impact += data.writes.impact
          rolling.competitor_mention += data.writes.competitor_mention
          setProcessed(totalProcessed)
          setWrites({ ...rolling })
          setCursor(data.nextCursor)
          if (data.sampleDiffs && data.sampleDiffs.length > 0 && totalProcessed <= 500) {
            setSamples(data.sampleDiffs)
          }
          if (data.done) {
            setCompleted(true)
            break
          }
          nextCursor = data.nextCursor
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setRunning(false)
      }
    },
    [headers],
  )

  const abort = () => {
    abortRef.current = true
  }

  const total = stats?.totalObservations ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Option C — Backfill derivations
            </CardTitle>
            <CardDescription>
              Walks every observation, writes v2 rows to sentiment/category/impact/competitor_mention.
              Append-only: v1 rows stay for replay.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={loadStats} disabled={running}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Observations: </span>
            <span className="font-mono font-semibold">{total.toLocaleString()}</span>
          </div>
          {stats?.versions && (
            <div className="flex gap-2">
              {Object.entries(stats.versions).map(([kind, v]) => (
                <Badge key={kind} variant="outline" className="font-mono text-xs">
                  {kind}:{v}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {(running || completed) && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {mode === "dry-run" ? "Dry run" : "Applying"} — {processed.toLocaleString()} / {total.toLocaleString()}
              </span>
              <span className="font-mono">{pct}%</span>
            </div>
            <Progress value={pct} />
            <div className="grid grid-cols-4 gap-2 text-xs font-mono">
              <div>sentiment: {writes.sentiment}</div>
              <div>category: {writes.category}</div>
              <div>impact: {writes.impact}</div>
              <div>competitor: {writes.competitor_mention}</div>
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Backfill error</AlertTitle>
            <AlertDescription className="font-mono text-xs break-all">{error}</AlertDescription>
          </Alert>
        )}

        {completed && !error && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>
              {mode === "dry-run" ? "Dry run complete" : "Backfill complete"}
            </AlertTitle>
            <AlertDescription>
              Processed {processed.toLocaleString()} observations.
              {mode === "apply" && ` Wrote ${writes.sentiment + writes.category + writes.impact + writes.competitor_mention} derivation rows.`}
            </AlertDescription>
          </Alert>
        )}

        {samples && samples.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Sample diffs (first 10)</summary>
            <div className="mt-2 space-y-1 font-mono">
              {samples.map((s) => (
                <div key={s.id} className="border-l-2 pl-2">
                  <div className="truncate">{s.title}</div>
                  <div className="text-muted-foreground">
                    {s.sentiment} · {s.category_slug ?? "—"} · impact {s.impact}
                    {s.competitors.length > 0 && ` · ${s.competitors.join(",")}`}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="flex gap-2 pt-2">
          <Button variant="outline" onClick={() => run(true)} disabled={running}>
            {running && mode === "dry-run" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Dry run
          </Button>
          <Button onClick={() => run(false)} disabled={running}>
            {running && mode === "apply" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Apply
          </Button>
          {running && (
            <Button variant="destructive" onClick={abort}>
              Abort
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Apply is safe to rerun — each RPC is idempotent per <code>(observation_id, algorithm_version)</code>.
          Cursor: <code className="font-mono">{cursor ?? "—"}</code>
        </p>
      </CardContent>
    </Card>
  )
}

function ClusteringPanel({ headers }: { headers: (extra?: HeadersInit) => HeadersInit }) {
  const [stats, setStats] = useState<ClusterStats | null>(null)
  const [running, setRunning] = useState(false)
  const [redetach, setRedetach] = useState(false)
  const [processed, setProcessed] = useState(0)
  const [attached, setAttached] = useState(0)
  const [detached, setDetached] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const [keys, setKeys] = useState<ClusterRebuildResponse["sampleKeys"]>([])
  const abortRef = useRef(false)

  const loadStats = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch("/api/admin/cluster", { headers: headers({}) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStats(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [headers])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const rebuild = useCallback(async () => {
    if (
      redetach &&
      !confirm(
        "Re-detach every observation before re-attaching?\n\nThis temporarily breaks cluster membership during the run. Only use when the cluster-key algorithm itself has changed.",
      )
    ) {
      return
    }

    setRunning(true)
    setError(null)
    setProcessed(0)
    setAttached(0)
    setDetached(0)
    setCompleted(false)
    setKeys([])
    abortRef.current = false

    let nextCursor: string | null = null
    let totalProcessed = 0
    let totalAttached = 0
    let totalDetached = 0

    try {
      while (!abortRef.current) {
        const res: Response = await fetch("/api/admin/cluster", {
          method: "POST",
          headers: headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ action: "rebuild", cursor: nextCursor, limit: 500, redetach }),
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
        }
        const data: ClusterRebuildResponse = await res.json()
        totalProcessed += data.processed
        totalAttached += data.attached
        totalDetached += data.detached ?? 0
        setProcessed(totalProcessed)
        setAttached(totalAttached)
        setDetached(totalDetached)
        if (data.sampleKeys && data.sampleKeys.length > 0 && totalProcessed <= 500) {
          setKeys(data.sampleKeys)
        }
        if (data.done) {
          setCompleted(true)
          break
        }
        nextCursor = data.nextCursor
      }
      await loadStats()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }, [headers, redetach, loadStats])

  const abort = () => {
    abortRef.current = true
  }

  const total = stats?.observations ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5" />
              Clustering
            </CardTitle>
            <CardDescription>
              Re-compute cluster membership for every observation via{" "}
              <code className="font-mono text-xs">buildClusterKey(title)</code>.
              Idempotent — safe to rerun.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={loadStats} disabled={running}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats && (
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div>
              <div className="text-muted-foreground">Observations</div>
              <div className="font-mono text-lg font-semibold">{stats.observations.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Clusters</div>
              <div className="font-mono text-lg font-semibold">{stats.clusters.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Active memberships</div>
              <div className="font-mono text-lg font-semibold">{stats.active_memberships.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Orphans (no cluster)</div>
              <div className="font-mono text-lg font-semibold">{stats.orphans.toLocaleString()}</div>
            </div>
          </div>
        )}

        {stats && stats.top_clusters.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Top 10 clusters by frequency</summary>
            <div className="mt-2 space-y-1 font-mono">
              {stats.top_clusters.map((c) => (
                <div key={c.cluster_id ?? c.cluster_key ?? ""} className="flex gap-2">
                  <span className="w-8 text-right">{c.frequency}×</span>
                  <span className="truncate">{c.canonical_title ?? "—"}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {(running || completed) && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Rebuilding — {processed.toLocaleString()} / {total.toLocaleString()}
              </span>
              <span className="font-mono">{pct}%</span>
            </div>
            <Progress value={pct} />
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div>attached: {attached}</div>
              {redetach && <div>detached: {detached}</div>}
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Cluster error</AlertTitle>
            <AlertDescription className="font-mono text-xs break-all">{error}</AlertDescription>
          </Alert>
        )}

        {completed && !error && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Rebuild complete</AlertTitle>
            <AlertDescription>
              Processed {processed.toLocaleString()}, attached {attached.toLocaleString()}
              {redetach && `, detached ${detached.toLocaleString()}`}.
            </AlertDescription>
          </Alert>
        )}

        {keys && keys.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Sample cluster keys (first 10)</summary>
            <div className="mt-2 space-y-1 font-mono">
              {keys.map((k) => (
                <div key={k.id} className="border-l-2 pl-2">
                  <div className="truncate">{k.title}</div>
                  <div className="text-muted-foreground">{k.cluster_key}</div>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={redetach}
              onChange={(e) => setRedetach(e.target.checked)}
              disabled={running}
            />
            Re-detach first (only when <code className="font-mono text-xs">buildClusterKey</code> itself changed)
          </label>
          <div className="flex gap-2 sm:ml-auto">
            <Button onClick={rebuild} disabled={running}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Rebuild clusters
            </Button>
            {running && (
              <Button variant="destructive" onClick={abort}>
                Abort
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function AdminPage() {
  const { secret, setSecret, headers } = useAdminSecret()

  return (
    <div className="container mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" />
            Back to dashboard
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Admin</h1>
          <p className="text-sm text-muted-foreground">
            Backfill + clustering maintenance. Append-only per <code className="font-mono text-xs">docs/ARCHITECTURE.md §7.4</code>.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Admin secret</CardTitle>
          <CardDescription>
            Required only if <code className="font-mono text-xs">ADMIN_SECRET</code> is set on the deploy.
            Stored in browser memory only; never persisted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            type="password"
            placeholder="x-admin-secret (leave empty if not configured)"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="max-w-md font-mono"
          />
        </CardContent>
      </Card>

      <BackfillPanel headers={headers} />
      <ClusteringPanel headers={headers} />
    </div>
  )
}
