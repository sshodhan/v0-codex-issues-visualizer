"use client"

import { useEffect, useState } from "react"
import { Loader2, Play, RefreshCw, TestTube2, XCircle } from "lucide-react"

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
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { logClientError, logClientEvent } from "@/lib/error-tracking/client-logger"

const ROUTE = "/api/admin/family-classification"

interface Stats {
  total_clusters: number | null
  without_classification: number | null
}

interface BackfillResult {
  dryRun: boolean
  candidates: number
  classified: number
  failed: number
  wouldProcess: number
  draft?: Record<string, unknown>
}

function authHeaders(secret: string): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" }
  if (secret) h["x-admin-secret"] = secret
  return h
}

async function explainAdminFailure(res: Response): Promise<string> {
  if (res.status === 401) {
    return "Admin secret required — paste it in the x-admin-secret field above."
  }
  if (res.status === 503) {
    return "ADMIN_SECRET is not configured on the server. Set the env var and redeploy."
  }
  if (res.status === 504) {
    return "Request timed out. Try a smaller batch or single cluster."
  }
  let body = ""
  try {
    body = (await res.text()).slice(0, 200)
  } catch {
    // ignore
  }
  return body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string
  value: number | null | undefined
  hint?: string
}) {
  const display = typeof value === "number" ? value.toLocaleString() : "—"
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{display}</div>
      {hint ? (
        <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export function FamilyClassificationPanel({ secret }: { secret: string }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState<string | null>(null)

  const [singleClusterId, setSingleClusterId] = useState("")
  const [running, setRunning] = useState<null | "dryRun" | "singleCluster" | "batch">(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<BackfillResult | null>(null)

  const loadStats = async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const res = await fetch(ROUTE, { headers: authHeaders(secret) })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as Stats
      setStats(data)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setStatsError(message)
      logClientError(e, "admin-family-classification-stats-failed")
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret])

  const runSingleCluster = async () => {
    if (!singleClusterId.trim()) {
      setRunError("Please provide a cluster ID")
      return
    }
    if (running) return

    setRunning("singleCluster")
    setRunError(null)
    setLastResult(null)
    const startedAt = Date.now()

    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ clusterId: singleClusterId, dryRun: false }),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        logClientError(new Error(message), "admin-family-classification-single-failed", {
          cluster_id: singleClusterId,
          status: res.status,
        })
        throw new Error(message)
      }
      const data = (await res.json()) as BackfillResult
      setLastResult(data)
      logClientEvent("admin-family-classification-single-succeeded", {
        cluster_id: singleClusterId,
        family_kind: data.draft?.family_kind,
        durationMs: Date.now() - startedAt,
      })
      setSingleClusterId("")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setRunError(message)
    } finally {
      setRunning(null)
    }
  }

  const runDryRun = async () => {
    if (running) return
    setRunning("dryRun")
    setRunError(null)
    setLastResult(null)
    const startedAt = Date.now()

    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ dryRun: true }),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        logClientError(new Error(message), "admin-family-classification-dryrun-failed", {
          status: res.status,
        })
        throw new Error(message)
      }
      const data = (await res.json()) as BackfillResult
      setLastResult(data)
      logClientEvent("admin-family-classification-dryrun-succeeded", {
        candidates: data.candidates,
        durationMs: Date.now() - startedAt,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setRunError(message)
    } finally {
      setRunning(null)
    }
  }

  const runBatch = async () => {
    if (running) return
    setRunning("batch")
    setRunError(null)
    setLastResult(null)
    const startedAt = Date.now()

    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ dryRun: false }),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        logClientError(new Error(message), "admin-family-classification-batch-failed", {
          status: res.status,
        })
        throw new Error(message)
      }
      const data = (await res.json()) as BackfillResult
      setLastResult(data)
      logClientEvent("admin-family-classification-batch-succeeded", {
        candidates: data.candidates,
        classified: data.classified,
        durationMs: Date.now() - startedAt,
      })
      await loadStats()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setRunError(message)
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="text-lg">Family Classification</CardTitle>
              <CardDescription>
                Classify clusters into family_kind (coherent, mixed, low-evidence, etc.) with optional LLM-generated title/summary.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={loadStats}
              disabled={statsLoading}
            >
              {statsLoading ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-4 w-4" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {statsError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load stats</AlertTitle>
              <AlertDescription className="text-xs">{statsError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            <StatTile
              label="Total clusters"
              value={stats?.total_clusters}
              hint="Every row in the clusters table."
            />
            <StatTile
              label="Without classification"
              value={stats?.without_classification}
              emphasis={(stats?.without_classification ?? 0) > 0}
              hint="Eligible for backfill."
            />
          </div>

          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            <div className="space-y-2">
              <label htmlFor="cluster-id" className="text-xs font-semibold uppercase text-muted-foreground">
                Classify single cluster
              </label>
              <div className="flex gap-2">
                <Input
                  id="cluster-id"
                  placeholder="Paste cluster UUID here"
                  value={singleClusterId}
                  onChange={(e) => setSingleClusterId(e.target.value)}
                  disabled={running !== null}
                  className="text-sm"
                />
                <Button
                  onClick={runSingleCluster}
                  disabled={running !== null || !singleClusterId.trim()}
                  size="sm"
                >
                  {running === "singleCluster" ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-1 h-4 w-4" />
                  )}
                  Classify
                </Button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={runDryRun}
              disabled={running !== null}
            >
              {running === "dryRun" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <TestTube2 className="mr-1 h-4 w-4" />
              )}
              Dry run
            </Button>
            <Button
              type="button"
              onClick={runBatch}
              disabled={running !== null || (stats?.without_classification ?? 0) === 0}
            >
              {running === "batch" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              Classify batch
            </Button>
            <p className="text-xs text-muted-foreground">
              Dry run previews how many clusters would be processed. Classify batch applies classifications to unclassified clusters.
            </p>
          </div>

          {runError ? (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertTitle>Operation failed</AlertTitle>
              <AlertDescription className="text-xs">{runError}</AlertDescription>
            </Alert>
          ) : null}

          {lastResult ? (
            <Alert className="border-blue-600/40 bg-blue-50/40 dark:bg-blue-950/20">
              <AlertTitle>
                {lastResult.dryRun ? "Dry run complete" : "Classification succeeded"}
              </AlertTitle>
              <AlertDescription className="space-y-2 text-xs">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <span className="text-muted-foreground">Candidates:</span>{" "}
                    <span className="font-medium tabular-nums">{lastResult.candidates}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {lastResult.dryRun ? "Would classify:" : "Classified:"}
                    </span>{" "}
                    <span className="font-medium tabular-nums">{lastResult.classified}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Failed:</span>{" "}
                    <span
                      className={
                        "font-medium tabular-nums " +
                        (lastResult.failed > 0 ? "text-amber-600" : "")
                      }
                    >
                      {lastResult.failed}
                    </span>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
