"use client"

import { useEffect, useMemo, useState } from "react"
import { CheckCircle2, ExternalLink, Loader2, Play, RefreshCw, TestTube2, XCircle } from "lucide-react"

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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { logClientError, logClientEvent } from "@/lib/error-tracking/client-logger"

const ROUTE = "/api/admin/cluster-label-backfill"
const SCRIPT_PATH = "scripts/021_backfill_deterministic_labels.ts"
const REPO_URL =
  "https://github.com/sshodhan/v0-codex-issues-visualizer/blob/main/" + SCRIPT_PATH

interface Stats {
  total: number
  candidates: number
  by_model: Array<{ label_model: string; clusters: number }>
}

interface RunSummary {
  dryRun: boolean
  mode: "dry-run" | "apply"
  candidate_clusters: number
  relabelled: number
  by_model: Record<string, number>
  rpc_failures: number
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
    return "Request timed out at the Vercel function limit. Try a smaller --limit or split the run into batches."
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
  emphasis,
}: {
  label: string
  value: number | null | undefined
  hint?: string
  emphasis?: boolean
}) {
  const display = typeof value === "number" ? value.toLocaleString() : "—"
  return (
    <div
      className={
        "rounded-md border p-3 " +
        (emphasis ? "border-amber-500/50 bg-amber-50/40 dark:bg-amber-950/20" : "")
      }
    >
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

export function ClusterLabelBackfillPanel({ secret }: { secret: string }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState<string | null>(null)

  const [running, setRunning] = useState<null | "dryRun" | "apply">(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<RunSummary | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const buildContext = (extra: Record<string, unknown> = {}) => ({
    candidates: stats?.candidates ?? null,
    total: stats?.total ?? null,
    ...extra,
  })

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
      logClientError(e, "admin-cluster-label-backfill-stats-failed")
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret])

  const runDryRun = async () => {
    if (running) return
    setRunning("dryRun")
    setRunError(null)
    setLastResult(null)
    const startedAt = Date.now()
    logClientEvent("admin-cluster-label-backfill-dryrun-started", buildContext())
    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ apply: false }),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        logClientError(new Error(message), "admin-cluster-label-backfill-dryrun-failed", {
          ...buildContext({ httpStatus: res.status, durationMs: Date.now() - startedAt }),
        })
        throw new Error(message)
      }
      const data = (await res.json()) as RunSummary
      setLastResult({ ...data, mode: "dry-run" })
      logClientEvent("admin-cluster-label-backfill-dryrun-succeeded", {
        ...buildContext({
          durationMs: Date.now() - startedAt,
          candidate_clusters: data.candidate_clusters,
        }),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setRunError(message)
    } finally {
      setRunning(null)
    }
  }

  const runApply = async () => {
    if (running) return
    setConfirmOpen(false)
    setRunning("apply")
    setRunError(null)
    setLastResult(null)
    const startedAt = Date.now()
    logClientEvent("admin-cluster-label-backfill-apply-started", buildContext())
    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ apply: true }),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        logClientError(new Error(message), "admin-cluster-label-backfill-apply-failed", {
          ...buildContext({ httpStatus: res.status, durationMs: Date.now() - startedAt }),
        })
        throw new Error(message)
      }
      const data = (await res.json()) as RunSummary
      setLastResult({ ...data, mode: "apply" })
      logClientEvent("admin-cluster-label-backfill-apply-succeeded", {
        ...buildContext({
          durationMs: Date.now() - startedAt,
          candidate_clusters: data.candidate_clusters,
          relabelled: data.relabelled,
          rpc_failures: data.rpc_failures,
        }),
      })
      // Refresh stats so the operator sees the updated by_model
      // distribution and the now-zero candidate count.
      await loadStats()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setRunError(message)
    } finally {
      setRunning(null)
    }
  }

  const byModelEntries = useMemo(() => stats?.by_model ?? [], [stats])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-lg">Cluster-label backfill</CardTitle>
            <CardDescription>
              Walks every cluster where{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                label IS NULL
              </code>
              ,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                label_confidence &lt; 0.6
              </code>
              , or{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                label_model = &apos;fallback:title&apos;
              </code>
              {" "}and recomputes a deterministic label
              (Topic+ErrorCode &rarr; Topic &rarr; ErrorCode &rarr; Title)
              via the same{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                composeDeterministicLabel
              </code>{" "}
              ladder the live producer uses. Idempotent: re-running only
              touches rows still under 0.6 confidence.
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
        </CardHeader>
        <CardContent className="space-y-4">
          {statsError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load stats</AlertTitle>
              <AlertDescription className="text-xs">{statsError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-3 md:grid-cols-3">
            <StatTile
              label="Clusters in DB"
              value={stats?.total}
              hint="Every row in the clusters table."
            />
            <StatTile
              label="Candidate clusters"
              value={stats?.candidates}
              emphasis={(stats?.candidates ?? 0) > 0}
              hint="Eligible for relabel — what Apply would touch."
            />
            <StatTile
              label="Already labelled"
              value={
                stats == null
                  ? null
                  : Math.max(0, stats.total - stats.candidates)
              }
              hint="Confident LLM or deterministic labels — preserved."
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Current label_model distribution
            </p>
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>label_model</TableHead>
                    <TableHead className="text-right">Clusters</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byModelEntries.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={2}
                        className="text-center text-xs text-muted-foreground"
                      >
                        {statsLoading ? "Loading…" : "No clusters yet."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    byModelEntries.map((row) => (
                      <TableRow key={row.label_model}>
                        <TableCell className="font-mono text-xs">
                          {row.label_model}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.clusters.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
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
              onClick={() => setConfirmOpen(true)}
              disabled={running !== null || (stats?.candidates ?? 0) === 0}
            >
              {running === "apply" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              Apply
            </Button>
            <p className="text-xs text-muted-foreground">
              Dry run is read-only and writes nothing to the database.
              Apply overwrites{" "}
              <code className="text-[11px]">label</code>,{" "}
              <code className="text-[11px]">label_confidence</code>,{" "}
              <code className="text-[11px]">label_model</code> on the{" "}
              {stats?.candidates ?? "—"} candidate row(s).
            </p>
          </div>

          {runError ? (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertTitle>Backfill failed</AlertTitle>
              <AlertDescription className="text-xs">{runError}</AlertDescription>
            </Alert>
          ) : null}

          {lastResult ? (
            <Alert
              className={
                lastResult.mode === "apply" && lastResult.rpc_failures === 0
                  ? "border-green-600/40 bg-green-50/40 dark:bg-green-950/20"
                  : lastResult.rpc_failures > 0
                    ? "border-amber-500/50 bg-amber-50/40 dark:bg-amber-950/20"
                    : undefined
              }
            >
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>
                {lastResult.mode === "dry-run"
                  ? "Dry run complete"
                  : lastResult.rpc_failures === 0
                    ? "Apply succeeded"
                    : `Apply finished with ${lastResult.rpc_failures} RPC failure(s)`}
              </AlertTitle>
              <AlertDescription className="space-y-2 text-xs">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <span className="text-muted-foreground">Candidates:</span>{" "}
                    <span className="font-medium tabular-nums">
                      {lastResult.candidate_clusters.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {lastResult.mode === "dry-run" ? "Would relabel:" : "Relabelled:"}
                    </span>{" "}
                    <span className="font-medium tabular-nums">
                      {lastResult.relabelled.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">RPC failures:</span>{" "}
                    <span
                      className={
                        "font-medium tabular-nums " +
                        (lastResult.rpc_failures > 0 ? "text-amber-600" : "")
                      }
                    >
                      {lastResult.rpc_failures.toLocaleString()}
                    </span>
                  </div>
                </div>
                {Object.keys(lastResult.by_model).length > 0 ? (
                  <div className="space-y-1">
                    <p className="font-medium">By model</p>
                    <ul className="space-y-0.5 font-mono">
                      {Object.entries(lastResult.by_model)
                        .sort((a, b) => b[1] - a[1])
                        .map(([model, count]) => (
                          <li key={model}>
                            {model}: <span className="tabular-nums">{count}</span>
                          </li>
                        ))}
                    </ul>
                  </div>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Collapsible>
        <Card>
          <CardHeader>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
              >
                <CardTitle className="text-base">
                  How this works (and how to run it from the CLI instead)
                </CardTitle>
                <span className="text-xs text-muted-foreground">Toggle</span>
              </button>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="space-y-3 text-sm">
              <p>
                The Apply button above calls{" "}
                <code className="text-[11px]">POST {ROUTE}</code> with{" "}
                <code className="text-[11px]">{`{ "apply": true }`}</code>. That
                route is a thin wrapper around{" "}
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
                >
                  <code className="text-[11px]">{SCRIPT_PATH}</code>
                  <ExternalLink className="h-3 w-3" />
                </a>{" "}
                and goes through the same{" "}
                <code className="text-[11px]">
                  lib/storage/run-cluster-label-backfill.ts
                </code>{" "}
                orchestrator, so the panel and the CLI behave identically.
              </p>
              <p className="font-medium">CLI equivalent</p>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs font-mono leading-relaxed">
                <code>{`# from the repo root, with Supabase env vars in .env.local
node --env-file=.env.local --experimental-strip-types \\
  scripts/021_backfill_deterministic_labels.ts --dry-run

# review scripts/tmp/cluster-label-backfill-*.json, then:
CLUSTER_LABEL_CONFIRM=yes \\
  node --env-file=.env.local --experimental-strip-types \\
  scripts/021_backfill_deterministic_labels.ts --apply`}</code>
              </pre>

              <div className="grid gap-3 md:grid-cols-2 pt-2">
                <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Before
                  </p>
                  <ul className="space-y-1 text-xs">
                    <li>Top Families cards show raw issue titles.</li>
                    <li>
                      <code className="text-[11px]">label IS NULL</code> count
                      &gt; 0.
                    </li>
                    <li>
                      <code className="text-[11px]">label_model</code> table
                      above is dominated by{" "}
                      <code className="text-[11px]">(null)</code> or{" "}
                      <code className="text-[11px]">fallback:title</code>.
                    </li>
                  </ul>
                </div>
                <div className="space-y-2 rounded-md border border-green-600/30 bg-green-50/40 p-3 dark:bg-green-950/20">
                  <p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
                    After
                  </p>
                  <ul className="space-y-1 text-xs">
                    <li>
                      Cards show family names like{" "}
                      <code className="text-[11px]">
                        Bug cluster &middot; ENOENT
                      </code>{" "}
                      or{" "}
                      <code className="text-[11px]">
                        Issue family &middot; &lt;short title&gt;
                      </code>
                      .
                    </li>
                    <li>Candidate count drops to zero.</li>
                    <li>
                      <code className="text-[11px]">label_model</code> table
                      shows the four{" "}
                      <code className="text-[11px]">deterministic:*</code>{" "}
                      rungs.
                    </li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply cluster-label backfill?</AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite{" "}
              <code className="text-[11px]">label</code>,{" "}
              <code className="text-[11px]">label_confidence</code>, and{" "}
              <code className="text-[11px]">label_model</code> on the{" "}
              <span className="font-medium">
                {(stats?.candidates ?? 0).toLocaleString()}
              </span>{" "}
              candidate cluster(s). High-confidence LLM labels (≥ 0.6) are
              preserved. Idempotent — safe to re-run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runApply}>
              Apply to {(stats?.candidates ?? 0).toLocaleString()} cluster(s)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
