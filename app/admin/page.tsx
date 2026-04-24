"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
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
import { logClientError, logClientEvent } from "@/lib/error-tracking/client-logger"
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

interface ClusterBatchResult {
  processed: number
  attached: number
  detached?: number
  nextCursor: string | null
  done: boolean
  refreshedMvs?: boolean
  sampleKeys?: SampleKey[]
}

interface ClusterBatchRow {
  id: number
  cursor: string | null
  status: "queued" | "running" | "completed" | "failed" | "aborted"
  processed: number
  attached: number
  detached: number
  error: string | null
  sampleKeys: SampleKey[]
}

interface ClassifyBackfillStats {
  /** All-time count of unclassified canonical rows at or above the
   *  effective threshold. What "Run until done" will actually
   *  process today (POST is all-time by design). Nullable when the
   *  underlying count query failed (partial-failure tolerance). */
  pendingCandidates: number | null
  /** All-time count regardless of impact score — the global deferral
   *  backlog. Preserved for back-compat with earlier panel UI. */
  pendingCandidatesAllImpact?: number
  defaultLimit: number
  maxLimit: number
  /** The effective threshold the server used to compute the counts
   *  above — echoes the admin form input (or the default when unset). */
  minImpactScore: number
  /** The hardcoded MIN_IMPACT_SCORE policy default. Reset target. */
  defaultMinImpactScore?: number
  openaiConfigured: boolean
  /** Window metadata echoed back by the server so the UI caption
   *  matches the scope of the counts. */
  window?: {
    days: number | null
    startIso: string | null
  }
  /** Full count breakdown across (threshold × window) quadrants so the
   *  panel can render a comparison matrix that aligns with the banner.
   *  Individual fields can be null when that specific count query failed
   *  (partial-failure tolerance) — the UI renders null as "—". */
  counts?: {
    atThresholdWindowed: number | null
    atDefaultWindowed: number | null
    allImpactWindowed: number | null
    atThresholdAllTime: number | null
    allImpactAllTime: number | null
  }
  /** Present when one or more count queries failed but others succeeded.
   *  Lets the admin UI surface a warning banner with the specific labels
   *  that didn't load so operators know which tiles are stale rather
   *  than silently seeing "—" everywhere. */
  warnings?: {
    failedCounts: Array<{ label: string; reason: string }>
  }
}

// Cost-per-observation estimate (gpt-5-mini rates). Documented in
// docs/ARCHITECTURE.md §3.5 and the classify-backfill panel
// description. Used to render a "lowering the threshold would cost ≈ $X"
// hint so operators can authorize spend deliberately.
const COST_PER_OBSERVATION_USD = 0.04

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

function dedupeClassifyFailures(items: ClassifyBackfillFailure[]): ClassifyBackfillFailure[] {
  const seen = new Set<string>()
  const deduped: ClassifyBackfillFailure[] = []
  for (const item of items) {
    const key = `${item.observationId}::${item.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }
  return deduped
}

interface ObservationTraceResponse {
  observation: {
    observation_id: string
    title: string
    url: string | null
    source_id: string | null
    external_id: string | null
    captured_at: string | null
    published_at: string | null
    cluster_id: string | null
    cluster_key: string | null
  }
  availability: Record<string, boolean>
  stages: {
    capture: { captured_at: string | null; published_at: string | null; source_id: string | null }
    fingerprint: { latest_computed_at: string | null; algorithm_version: string | null; total_versions: number; rows: Array<Record<string, unknown>> }
    embedding: { latest_computed_at: string | null; algorithm_version: string | null; model: string | null; dimensions: number | null; total_versions: number; rows: Array<Record<string, unknown>> }
    clustering: { active_cluster_id: string | null; active_cluster_key: string | null; active_cluster_size: number | null; memberships: Array<Record<string, unknown>> }
    classification: { latest_created_at: string | null; latest_algorithm_version: string | null; latest_model_used: string | null; total_versions: number; chain_head_id: string | null; lineage: Array<Record<string, unknown>> }
    review: { total_reviews: number; latest_reviewed_at: string | null }
  }
  generated_at: string
}

interface ProcessingEventItem {
  id: string
  stage: string
  status: string
  algorithm_version_model: string | null
  detail_json: Record<string, unknown> | null
  created_at: string
}

const ADMIN_TAB_VALUES = ["backfill", "classify-backfill", "clustering", "trace", "schema"] as const
type AdminTab = (typeof ADMIN_TAB_VALUES)[number]

// `useSearchParams()` bails out of static prerender in Next.js 15 and
// requires a Suspense boundary, or `next build` fails with a prerender
// error on `/admin`. Keep the hook's caller inside a child component and
// wrap it below; fallback renders the default tab so the page isn't
// blank during the client-hydration round-trip.
export default function AdminPage() {
  return (
    <Suspense fallback={<AdminPageContent initialTab="backfill" />}>
      <AdminPageWithTab />
    </Suspense>
  )
}

function AdminPageWithTab() {
  const searchParams = useSearchParams()
  // Deep-linkable tabs: the AI triage empty-state panel links to
  // `/admin?tab=classify-backfill` (etc.) so reviewers land directly on
  // the panel they came to run. Unknown or missing values fall back to
  // "backfill" so a stale link never produces a blank tab pane.
  const initialTab = useMemo<AdminTab>(() => {
    const raw = searchParams?.get("tab")
    return (ADMIN_TAB_VALUES as readonly string[]).includes(raw ?? "")
      ? (raw as AdminTab)
      : "backfill"
  }, [searchParams])

  return <AdminPageContent initialTab={initialTab} />
}

function AdminPageContent({ initialTab }: { initialTab: AdminTab }) {
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
        <Tabs defaultValue={initialTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="backfill">Backfill</TabsTrigger>
            <TabsTrigger value="classify-backfill">Classify backfill</TabsTrigger>
            <TabsTrigger value="clustering">Clustering</TabsTrigger>
            <TabsTrigger value="trace">Observation trace</TabsTrigger>
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
          <TabsContent value="trace">
            <ObservationTracePanel secret={secret} />
          </TabsContent>
          <TabsContent value="schema">
            <SchemaVerificationPanel secret={secret} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

function ObservationTracePanel({ secret }: { secret: string }) {
  const searchParams = useSearchParams()
  const [observationId, setObservationId] = useState("")
  const [trace, setTrace] = useState<ObservationTraceResponse | null>(null)
  const [events, setEvents] = useState<ProcessingEventItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fromUrl = searchParams?.get("observation") ?? ""
    if (fromUrl) setObservationId(fromUrl)
  }, [searchParams])

  async function loadTrace() {
    const id = observationId.trim()
    if (!id) {
      setError("Provide an observation ID.")
      return
    }
    setLoading(true)
    setError(null)
    setTrace(null)
    setEvents([])
    try {
      const [traceRes, classifyRes] = await Promise.all([
        fetch(`/api/observations/${id}/trace`, { headers: authHeaders(secret) }),
        fetch(`/api/observations/${id}/classify`, { headers: authHeaders(secret) }),
      ])
      if (!traceRes.ok) {
        setError(await explainAdminFailure(traceRes))
        return
      }
      setTrace((await traceRes.json()) as ObservationTraceResponse)
      if (classifyRes.ok) {
        const body = (await classifyRes.json()) as { trace?: { events?: ProcessingEventItem[] } }
        setEvents(body.trace?.events ?? [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trace")
      logClientError(e, "admin-trace-fetch-failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unified observation trace</CardTitle>
        <CardDescription>
          Capture → fingerprint → embedding → cluster membership → classification chain → review lineage, with an append-only processing event stream.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 md:flex-row">
          <Input
            value={observationId}
            onChange={(e) => setObservationId(e.target.value)}
            placeholder="Observation UUID"
            className="font-mono"
          />
          <Button onClick={loadTrace} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Load trace
          </Button>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Trace load failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {trace ? (
          <div className="space-y-3">
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{trace.observation.title}</p>
              <p className="text-xs text-muted-foreground">{trace.observation.observation_id}</p>
              {trace.observation.url ? (
                <a className="text-xs text-primary hover:underline" href={trace.observation.url} target="_blank" rel="noreferrer">
                  Open source URL
                </a>
              ) : null}
            </div>
            <TraceStage
              title="Capture"
              available={trace.availability.capture}
              meta={[
                ["captured_at", trace.stages.capture.captured_at],
                ["published_at", trace.stages.capture.published_at],
                ["source_id", trace.stages.capture.source_id],
              ]}
            />
            <TraceStage
              title="Fingerprint"
              available={trace.availability.fingerprint}
              meta={[
                ["algorithm_version", trace.stages.fingerprint.algorithm_version],
                ["latest_computed_at", trace.stages.fingerprint.latest_computed_at],
                ["versions", String(trace.stages.fingerprint.total_versions)],
              ]}
            />
            <TraceStage
              title="Embedding"
              available={trace.availability.embedding}
              meta={[
                ["algorithm_version", trace.stages.embedding.algorithm_version],
                ["model", trace.stages.embedding.model],
                ["dimensions", trace.stages.embedding.dimensions === null ? null : String(trace.stages.embedding.dimensions)],
                ["latest_computed_at", trace.stages.embedding.latest_computed_at],
              ]}
            />
            <TraceStage
              title="Cluster membership"
              available={trace.availability.clustering}
              meta={[
                ["active_cluster_id", trace.stages.clustering.active_cluster_id],
                ["active_cluster_key", trace.stages.clustering.active_cluster_key],
                ["active_cluster_size", trace.stages.clustering.active_cluster_size === null ? null : String(trace.stages.clustering.active_cluster_size)],
                ["memberships", String(trace.stages.clustering.memberships.length)],
              ]}
            />
            <TraceStage
              title="Classification chain"
              available={trace.availability.classification}
              meta={[
                ["latest_model", trace.stages.classification.latest_model_used],
                ["latest_algorithm", trace.stages.classification.latest_algorithm_version],
                ["latest_created_at", trace.stages.classification.latest_created_at],
                ["versions", String(trace.stages.classification.total_versions)],
              ]}
            >
              {trace.stages.classification.lineage.length > 0 ? (
                <div className="space-y-2">
                  {trace.stages.classification.lineage.map((node, idx) => (
                    <div key={String(node.id)} className="rounded border bg-muted/40 p-2 text-xs">
                      <p className="font-mono">{String(node.id)}</p>
                      <p>{String(node.category ?? "unknown")} · {String(node.severity ?? "unknown")} · {String(node.status ?? "unknown")}</p>
                      <p className="text-muted-foreground">prior: {String(node.prior_classification_id ?? "none")} {idx === 0 ? "(head)" : ""}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </TraceStage>
            <TraceStage
              title="Review lineage"
              available={trace.availability.review}
              meta={[
                ["total_reviews", String(trace.stages.review.total_reviews)],
                ["latest_reviewed_at", trace.stages.review.latest_reviewed_at],
                ["generated_at", trace.generated_at],
              ]}
            />
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">Processing event stream</p>
                <Badge variant="outline">append-only</Badge>
              </div>
              {events.length === 0 ? (
                <p className="text-xs text-muted-foreground">No processing events recorded.</p>
              ) : (
                <div className="space-y-2">
                  {events.map((event) => (
                    <div key={event.id} className="rounded border p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{event.stage}</Badge>
                        <Badge>{event.status}</Badge>
                        {event.algorithm_version_model ? (
                          <span className="font-mono text-muted-foreground">{event.algorithm_version_model}</span>
                        ) : null}
                        <span className="text-muted-foreground">{new Date(event.created_at).toISOString()}</span>
                      </div>
                      {event.detail_json && Object.keys(event.detail_json).length > 0 ? (
                        <pre className="mt-1 overflow-x-auto rounded bg-muted p-1 text-[10px]">
                          {JSON.stringify(event.detail_json, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

// Small presentational helper used by ClassifyBackfillPanel. Either a
// numeric `value` (formatted with toLocaleString and showing "—" for
// undefined) or a pre-formatted `valueText` string (for the "configured
// / missing" OpenAI tile). `hint` renders small muted text below.
function StatTile({
  label,
  value,
  valueText,
  hint,
}: {
  label: string
  value?: number | null | undefined
  valueText?: string
  hint?: string
}) {
  const display =
    valueText !== undefined
      ? valueText
      : typeof value === "number"
        ? value.toLocaleString()
        : "—"
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

function TraceStage({
  title,
  available,
  meta,
  children,
}: {
  title: string
  available: boolean
  meta: Array<[string, string | null]>
  children?: ReactNode
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium">{title}</p>
        <Badge variant={available ? "secondary" : "outline"}>{available ? "available" : "missing"}</Badge>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
        {meta.map(([k, v]) => (
          <p key={k}>
            <span className="font-mono text-foreground">{k}</span>: {v ?? "—"}
          </p>
        ))}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
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
  if (res.status === 504) {
    // Vercel's generic 504 for exceeded maxDuration — classify batches
    // hit this when OpenAI latency + MV refresh blow past the 60s function
    // cap. Actionable message beats the raw FUNCTION_INVOCATION_TIMEOUT.
    return (
      "Request timed out at 60s (Vercel function limit). For classify-backfill this usually means the batch " +
      "was larger than gpt-5-mini can finish in time — reduce the batch limit (try 5), or avoid running while " +
      "the 03:00 UTC cron tick is active. Try again; nothing was committed."
    )
  }
  let body = ""
  try {
    body = (await res.text()).slice(0, 200)
  } catch {
    // ignore
  }
  return body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`
}

function makeAdminHttpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number }
  err.status = status
  return err
}

function shouldLogAdminClientError(error: unknown) {
  const status = (error as { status?: number })?.status
  // 401/403 are expected until the operator provides x-admin-secret.
  return status !== 401 && status !== 403
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
      if (!res.ok) throw makeAdminHttpError(res.status, await explainAdminFailure(res))
      const data = (await res.json()) as BackfillStats
      setStats(data)
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
      if (shouldLogAdminClientError(e)) {
        logClientError(e, "admin-backfill-stats-failed")
      }
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
          throw makeAdminHttpError(res.status, await explainAdminFailure(res))
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
        if (shouldLogAdminClientError(e)) {
          logClientError(e, "admin-backfill-run-failed", { dryRun })
        }
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
  const [batchRows, setBatchRows] = useState<ClusterBatchRow[]>([])
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null)
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
      if (!res.ok) throw makeAdminHttpError(res.status, await explainAdminFailure(res))
      const data = (await res.json()) as ClusterStats
      setStats(data)
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
      if (shouldLogAdminClientError(e)) {
        logClientError(e, "admin-cluster-stats-failed")
      }
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
    setBatchRows([])
    setSelectedBatchId(null)
    setRunError(null)
    setRefreshedMvs(false)

    const abort = new AbortController()
    abortRef.current = abort
    let cursor: string | null = null
    let seenSamples = false
    let batchIdCounter = 1

    try {
      while (!abort.signal.aborted) {
        const batchId = batchIdCounter++
        setBatchRows((rows) => [
          ...rows,
          {
            id: batchId,
            cursor,
            status: "running",
            processed: 0,
            attached: 0,
            detached: 0,
            error: null,
            sampleKeys: [],
          },
        ])
        if (selectedBatchId == null) setSelectedBatchId(batchId)

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
          const message = await explainAdminFailure(res)
          setBatchRows((rows) =>
            rows.map((row) =>
              row.id === batchId ? { ...row, status: "failed", error: message } : row,
            ),
          )
          const error = makeAdminHttpError(res.status, message)
          if (shouldLogAdminClientError(error)) {
            logClientError(error, "admin-cluster-batch-failed", {
              batchId,
              cursor,
              redetach,
              status: res.status,
            })
          }
          throw error
        }
        const data = (await res.json()) as ClusterBatchResult
        const batchProcessed = Number(data.processed ?? 0)
        const batchAttached = Number(data.attached ?? 0)
        const batchDetached = typeof data.detached === "number" ? data.detached : 0

        setBatchRows((rows) =>
          rows.map((row) =>
            row.id === batchId
              ? {
                  ...row,
                  status: "completed",
                  processed: batchProcessed,
                  attached: batchAttached,
                  detached: batchDetached,
                  sampleKeys: Array.isArray(data.sampleKeys) ? data.sampleKeys : [],
                }
              : row,
          ),
        )

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
        if (shouldLogAdminClientError(e)) {
          logClientError(e, "admin-cluster-rebuild-failed", { redetach })
        }
      } else {
        setBatchRows((rows) => {
          const next = [...rows]
          const idx = next.findIndex((row) => row.status === "running")
          if (idx >= 0) next[idx] = { ...next[idx], status: "aborted", error: "Aborted by user" }
          return next
        })
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
  const selectedBatch =
    selectedBatchId != null ? batchRows.find((row) => row.id === selectedBatchId) ?? null : null

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

        {batchRows.length > 0 && (
          <Collapsible defaultOpen>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                Cluster batches ({batchRows.length})
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-3">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Batch</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Processed</TableHead>
                      <TableHead>Attached</TableHead>
                      {redetach && <TableHead>Detached</TableHead>}
                      <TableHead>Cursor</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batchRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono text-xs">#{row.id}</TableCell>
                        <TableCell>
                          <Badge variant={row.status === "completed" ? "default" : row.status === "failed" ? "destructive" : "secondary"}>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">{row.processed.toLocaleString()}</TableCell>
                        <TableCell className="tabular-nums">{row.attached.toLocaleString()}</TableCell>
                        {redetach && <TableCell className="tabular-nums">{row.detached.toLocaleString()}</TableCell>}
                        <TableCell className="max-w-[220px] truncate font-mono text-[11px]" title={row.cursor ?? "start"}>
                          {row.cursor ?? "start"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant={selectedBatchId === row.id ? "default" : "outline"}
                            size="sm"
                            onClick={() => setSelectedBatchId(row.id)}
                          >
                            View
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {selectedBatch && (
                <div className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">Batch #{selectedBatch.id}</span>
                    <Badge variant={selectedBatch.status === "completed" ? "default" : selectedBatch.status === "failed" ? "destructive" : "secondary"}>
                      {selectedBatch.status}
                    </Badge>
                  </div>
                  {selectedBatch.error && (
                    <div className="text-xs text-destructive">{selectedBatch.error}</div>
                  )}
                  {selectedBatch.sampleKeys.length > 0 ? (
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Title</TableHead>
                            <TableHead>Cluster key</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedBatch.sampleKeys.map((k) => (
                            <TableRow key={`${selectedBatch.id}-${k.id}`}>
                              <TableCell className="max-w-[520px] truncate" title={k.title}>
                                {k.title}
                              </TableCell>
                              <TableCell className="font-mono text-xs">{k.cluster_key}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      No sample keys captured for this batch yet (placeholder row).
                    </div>
                  )}
                </div>
              )}
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
  // Editable threshold. Starts at the server-reported default (which is
  // the hardcoded MIN_IMPACT_SCORE); operator can lower it to preview
  // what a more permissive policy would pick up. Kept as a string so
  // we don't clobber the input mid-typing with a partial-number clamp.
  const [thresholdInput, setThresholdInput] = useState("")
  // Window for the stats query. `null` means "all time". Defaults to
  // 30d so the counts match the dashboard banner out of the box.
  const [windowDays, setWindowDays] = useState<number | null>(30)
  const [running, setRunning] = useState<null | "dryRun" | "batch" | "loop">(null)
  const [dryRunPreview, setDryRunPreview] =
    useState<{ pendingCandidates: number; wouldProcess: number; minImpactScore: number } | null>(null)
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

  // Parse the editable threshold. An empty string falls back to the
  // server-reported default so the form can't ship an invalid value
  // to the API (the server also clamps, but doing it here keeps the
  // local counts accurate while typing).
  const parsedThreshold = useMemo(() => {
    if (thresholdInput === "") return stats?.defaultMinImpactScore ?? stats?.minImpactScore ?? 6
    const n = Number.parseFloat(thresholdInput)
    if (!Number.isFinite(n)) return stats?.defaultMinImpactScore ?? stats?.minImpactScore ?? 6
    return Math.max(0, Math.min(10, Math.round(n * 10) / 10))
  }, [thresholdInput, stats?.defaultMinImpactScore, stats?.minImpactScore])

  const defaultThreshold = stats?.defaultMinImpactScore ?? stats?.minImpactScore ?? 6
  const thresholdDiverges = parsedThreshold !== defaultThreshold

  const loadStats = async (opts?: { threshold?: number; days?: number | null }) => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const thresholdForQuery = opts?.threshold ?? parsedThreshold
      const daysForQuery = opts?.days !== undefined ? opts.days : windowDays
      const qs = new URLSearchParams()
      qs.set("minImpactScore", String(thresholdForQuery))
      qs.set("days", daysForQuery === null ? "all" : String(daysForQuery))
      const res = await fetch(`/api/admin/classify-backfill?${qs.toString()}`, {
        headers: authHeaders(secret),
      })
      if (!res.ok) throw makeAdminHttpError(res.status, await explainAdminFailure(res))
      const data = (await res.json()) as ClassifyBackfillStats
      setStats(data)
      setLimit((current) =>
        current === 10 || !Number.isFinite(current) ? data.defaultLimit : current,
      )
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
      if (shouldLogAdminClientError(e)) {
        logClientError(e, "admin-classify-backfill-stats-failed")
      }
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret])

  // When the operator changes threshold or window, refetch the stats so
  // every count on the panel reflects the new scope. Debounced 300ms so
  // typing "56" in the threshold input only fires one request, not two,
  // and so rapid arrow-key jogging on the Window select doesn't pile
  // five concurrent refetches on top of any in-flight POST.
  useEffect(() => {
    if (stats === null) return // initial load handled above
    const timer = setTimeout(() => {
      loadStats({ threshold: parsedThreshold, days: windowDays })
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedThreshold, windowDays])

  const resetThreshold = () => {
    setThresholdInput("")
  }

  const resetBeforeRun = () => {
    setDryRunPreview(null)
    setLastBatch(null)
    setFailures([])
    setLoopTotals({ classified: 0, skipped: 0, failed: 0, batches: 0 })
    setRunError(null)
    setRefreshedMvs(false)
  }

  // Build the structured context object that accompanies every
  // classify-backfill lifecycle event (start/success/failure). Captures
  // enough state that a future reader of the logs can reconstruct
  // exactly what the operator did — threshold, window, batch size,
  // authoritative config values — without having to stitch multiple
  // logs together.
  const buildBackfillContext = (extra: Record<string, unknown> = {}) => ({
    threshold: parsedThreshold,
    thresholdDiverges,
    defaultThreshold,
    windowDays,
    limit,
    ...extra,
  })

  const runDryRun = async () => {
    if (running) return
    setRunning("dryRun")
    resetBeforeRun()
    const startedAt = Date.now()
    logClientEvent("admin-classify-backfill-dryrun-started", buildBackfillContext())
    try {
      const res = await fetch("/api/admin/classify-backfill", {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ dryRun: true, limit, minImpactScore: parsedThreshold }),
      })
      if (!res.ok) throw makeAdminHttpError(res.status, await explainAdminFailure(res))
      const data = (await res.json()) as {
        pendingCandidates: number
        wouldProcess: number
        minImpactScore: number
      }
      setDryRunPreview({
        pendingCandidates: data.pendingCandidates,
        wouldProcess: data.wouldProcess,
        minImpactScore: data.minImpactScore,
      })
      logClientEvent(
        "admin-classify-backfill-dryrun-succeeded",
        buildBackfillContext({
          durationMs: Date.now() - startedAt,
          pendingCandidates: data.pendingCandidates,
          wouldProcess: data.wouldProcess,
          effectiveThreshold: data.minImpactScore,
        }),
      )
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
      if (shouldLogAdminClientError(e)) {
        logClientError(
          e,
          "admin-classify-backfill-dryrun-failed",
          buildBackfillContext({
            durationMs: Date.now() - startedAt,
            httpStatus: (e as { status?: number }).status,
          }),
        )
      }
    } finally {
      setRunning(null)
    }
  }

  const runOneBatch = async () => {
    if (running) return
    setRunning("batch")
    resetBeforeRun()
    const startedAt = Date.now()
    logClientEvent("admin-classify-backfill-batch-started", buildBackfillContext())
    try {
      const res = await fetch("/api/admin/classify-backfill", {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ limit, minImpactScore: parsedThreshold }),
      })
      if (!res.ok) throw makeAdminHttpError(res.status, await explainAdminFailure(res))
      const data = (await res.json()) as ClassifyBackfillBatchResult
      setLastBatch(data)
      setFailures(dedupeClassifyFailures(data.failures ?? []))
      setRefreshedMvs(data.refreshedMvs)
      logClientEvent(
        "admin-classify-backfill-batch-succeeded",
        buildBackfillContext({
          durationMs: Date.now() - startedAt,
          candidates: data.candidates,
          classified: data.classified,
          skipped: data.skipped,
          failed: data.failed,
          refreshedMvs: data.refreshedMvs,
        }),
      )
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
      if (shouldLogAdminClientError(e)) {
        logClientError(
          e,
          "admin-classify-backfill-batch-failed",
          buildBackfillContext({
            durationMs: Date.now() - startedAt,
            httpStatus: (e as { status?: number }).status,
          }),
        )
      }
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
    const loopStartedAt = Date.now()
    const loopAcc = { classified: 0, skipped: 0, failed: 0, batches: 0 }
    logClientEvent(
      "admin-classify-backfill-loop-started",
      buildBackfillContext({
        initialPendingAtThreshold:
          stats && stats.pendingCandidates !== null ? stats.pendingCandidates : null,
      }),
    )

    try {
      // Use the stats count as an upper bound on iterations so a
      // pathological server always-returns-nonzero bug can't run
      // forever. /ceil(limit, pending) + slack is generous. Null pending
      // (partial count failure) falls back to the conservative 200-iter
      // cap so the loop still terminates.
      let safetyIterations =
        stats && stats.pendingCandidates !== null
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
          body: JSON.stringify({ dryRun: true, limit, minImpactScore: parsedThreshold }),
        })
        if (!pendingRes.ok) {
          throw makeAdminHttpError(
            pendingRes.status,
            await explainAdminFailure(pendingRes),
          )
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
          body: JSON.stringify({
            limit,
            refreshMvs: isFinalBatch,
            minImpactScore: parsedThreshold,
          }),
        })
        if (!res.ok) {
          consecutiveErrors += 1
          const msg = await explainAdminFailure(res)
          if (consecutiveErrors >= 3) {
            throw makeAdminHttpError(
              res.status,
              `Aborted after 3 consecutive errors: ${msg}`,
            )
          }
          await new Promise((r) => setTimeout(r, 1000 * consecutiveErrors))
          continue
        }
        consecutiveErrors = 0
        const data = (await res.json()) as ClassifyBackfillBatchResult
        setLastBatch(data)
        loopAcc.classified += data.classified
        loopAcc.skipped += data.skipped
        loopAcc.failed += data.failed
        loopAcc.batches += 1
        setLoopTotals({ ...loopAcc })
        logClientEvent(
          "admin-classify-backfill-loop-batch",
          buildBackfillContext({
            batchIndex: loopAcc.batches,
            candidates: data.candidates,
            classified: data.classified,
            skipped: data.skipped,
            failed: data.failed,
            refreshedMvs: data.refreshedMvs,
            isFinalBatch,
          }),
        )
        if (data.failures?.length) {
          collectedFailures.push(...data.failures)
          setFailures(dedupeClassifyFailures(collectedFailures))
        }
        if (data.refreshedMvs) finalRefreshedMvs = true

        // No-op batch means everything this round was already
        // classified; nothing to page further.
        if (data.candidates === 0) break

        // Spacing keeps rate-limit clusters at bay between batches.
        await new Promise((r) => setTimeout(r, 500))
      }
      setRefreshedMvs(finalRefreshedMvs)
      logClientEvent(
        "admin-classify-backfill-loop-succeeded",
        buildBackfillContext({
          durationMs: Date.now() - loopStartedAt,
          totalBatches: loopAcc.batches,
          totalClassified: loopAcc.classified,
          totalSkipped: loopAcc.skipped,
          totalFailed: loopAcc.failed,
          failureCount: collectedFailures.length,
          refreshedMvs: finalRefreshedMvs,
          aborted: abort.signal.aborted,
        }),
      )
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setRunError(e instanceof Error ? e.message : String(e))
        if (shouldLogAdminClientError(e)) {
          logClientError(
            e,
            "admin-classify-backfill-loop-failed",
            buildBackfillContext({
              durationMs: Date.now() - loopStartedAt,
              totalBatches: loopAcc.batches,
              totalClassified: loopAcc.classified,
              totalFailed: loopAcc.failed,
              consecutiveErrors,
              httpStatus: (e as { status?: number }).status,
            }),
          )
        }
      } else {
        logClientEvent(
          "admin-classify-backfill-loop-aborted",
          buildBackfillContext({
            durationMs: Date.now() - loopStartedAt,
            totalBatches: loopAcc.batches,
            totalClassified: loopAcc.classified,
          }),
        )
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
              Routes unclassified canonical observations through the LLM
              pipeline. Impact score gates spend — the default policy
              (configured in <span className="font-mono">lib/classification/run-backfill-constants.ts</span>)
              only processes rows at or above the impact threshold. Use the
              controls below to lower the threshold temporarily and preview
              what a more permissive policy would pick up; the daily cron
              and the dashboard banner always use the default. Costs
              ~${COST_PER_OBSERVATION_USD.toFixed(2)} per observation at
              gpt-5-mini rates. On Hobby keep per-batch limit ≤ 15 so
              ~3-5s/call stays under the 60s timeout. Avoid running while
              the 03:00 UTC cron tick may be active — overlapping runs can
              race on the dedupe check (BUGS.md N-9).
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

        {stats?.warnings?.failedCounts && stats.warnings.failedCounts.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>
              Partial stats failure — {stats.warnings.failedCounts.length} of 5 counts didn&apos;t load
            </AlertTitle>
            <AlertDescription>
              <p className="text-xs">
                Tiles below show &ldquo;—&rdquo; for the counts that failed. Try refreshing; if
                the same counts fail again, check Vercel logs for{" "}
                <span className="font-mono">classify-backfill count_partial_failure</span>.
              </p>
              <ul className="mt-1 list-disc pl-5 text-[11px] leading-tight">
                {stats.warnings.failedCounts.map((f) => (
                  <li key={f.label}>
                    <span className="font-mono">{f.label}</span>: {f.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Scope selector: window + threshold. Changing either refetches
            all counts so every tile below updates in lockstep with the
            dashboard banner. */}
        <div className="grid grid-cols-1 gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-[auto_auto_1fr_auto]">
          <div>
            <label
              htmlFor="classify-days"
              className="mb-1 block text-xs text-muted-foreground"
            >
              Window
            </label>
            <select
              id="classify-days"
              value={windowDays === null ? "all" : String(windowDays)}
              onChange={(e) => {
                const v = e.target.value
                setWindowDays(v === "all" ? null : Number.parseInt(v, 10))
              }}
              disabled={running !== null}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="all">All time</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="classify-threshold"
              className="mb-1 block text-xs text-muted-foreground"
            >
              Min impact score
            </label>
            <Input
              id="classify-threshold"
              type="number"
              min={0}
              max={10}
              step={0.1}
              value={thresholdInput === "" ? defaultThreshold : thresholdInput}
              onChange={(e) => setThresholdInput(e.target.value)}
              disabled={running !== null}
              className="h-9 w-24 tabular-nums"
            />
          </div>
          <div className="flex items-end">
            <p className="text-[11px] leading-snug text-muted-foreground">
              {thresholdDiverges ? (
                <>
                  Experimenting at{" "}
                  <span className="font-mono text-foreground">{parsedThreshold}</span>.
                  Daily cron &amp; dashboard banner continue at the{" "}
                  <span className="font-mono text-foreground">{defaultThreshold}</span>
                  {" "}default — this override only affects this session.
                </>
              ) : (
                <>
                  At policy default{" "}
                  <span className="font-mono text-foreground">{defaultThreshold}</span>.
                  Lower the threshold to preview what a more permissive policy would
                  process (≈ ${COST_PER_OBSERVATION_USD.toFixed(2)} per extra observation).
                </>
              )}
            </p>
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              size="sm"
              onClick={resetThreshold}
              disabled={!thresholdDiverges || running !== null}
              title="Reset threshold to policy default"
            >
              Reset to {defaultThreshold}
            </Button>
          </div>
        </div>

        {/* Stats matrix. Two rows of three tiles:
             Row 1 — scoped to the selected window, matches dashboard banner.
             Row 2 — all-time scope, matches what "Run until done" processes. */}
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            In the selected window
            {stats?.window?.days !== undefined && stats.window.days !== null
              ? ` (last ${stats.window.days} days)`
              : " (all time)"}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
              label={`At threshold ${parsedThreshold}`}
              value={stats?.counts?.atThresholdWindowed}
              hint={thresholdDiverges
                ? `vs ${stats?.counts?.atDefaultWindowed ?? "—"} at default ${defaultThreshold}`
                : "would be processed if run at this scope"}
            />
            <StatTile
              label={`At default ${defaultThreshold}`}
              value={stats?.counts?.atDefaultWindowed}
              hint="matches dashboard banner's high-impact count"
            />
            <StatTile
              label="Unclassified (all impact levels)"
              value={stats?.counts?.allImpactWindowed}
              hint="matches dashboard banner's total pending"
            />
          </div>
        </div>

        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            All-time operational scope — what &ldquo;Run until done&rdquo; processes
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
              label="Pending candidates"
              value={stats?.pendingCandidates}
              hint={thresholdDiverges
                ? `at threshold ${parsedThreshold} — would process ≈ $${((stats?.pendingCandidates ?? 0) * COST_PER_OBSERVATION_USD).toFixed(2)}`
                : `at default ${defaultThreshold} — would process ≈ $${((stats?.pendingCandidates ?? 0) * COST_PER_OBSERVATION_USD).toFixed(2)}`}
            />
            <StatTile
              label="Below-threshold backlog"
              value={
                stats &&
                stats.pendingCandidatesAllImpact != null &&
                stats.pendingCandidates != null
                  ? Math.max(0, stats.pendingCandidatesAllImpact - stats.pendingCandidates)
                  : undefined
              }
              hint={`deferred by policy (impact < ${parsedThreshold})`}
            />
            <StatTile
              label="OpenAI key"
              valueText={stats ? (openaiOk ? "configured" : "missing") : "—"}
              hint={openaiOk ? "classifier ready" : "set OPENAI_API_KEY to enable"}
            />
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
              At threshold{" "}
              <span className="font-mono">{dryRunPreview.minImpactScore}</span>{" "}
              there {dryRunPreview.pendingCandidates === 1 ? "is" : "are"}{" "}
              {dryRunPreview.pendingCandidates.toLocaleString()} pending
              candidate
              {dryRunPreview.pendingCandidates === 1 ? "" : "s"} (all-time).
              The next batch would process{" "}
              {dryRunPreview.wouldProcess.toLocaleString()} at the current
              limit — estimated cost{" "}
              ≈ ${(dryRunPreview.wouldProcess * COST_PER_OBSERVATION_USD).toFixed(2)}.
              No tokens spent on this preview.
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
            <AlertTitle>All caught up at threshold {parsedThreshold}</AlertTitle>
            <AlertDescription>
              0 pending at this threshold, all-time. {stats.pendingCandidatesAllImpact != null && stats.pendingCandidatesAllImpact > 0 ? (
                <>
                  {stats.pendingCandidatesAllImpact.toLocaleString()} unclassified
                  observations remain below the threshold — lower the threshold above to
                  preview what processing them would cost, or leave the current policy in
                  place to defer them.
                </>
              ) : (
                <>No canonical observations currently need classification.</>
              )}
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
      if (!res.ok) throw makeAdminHttpError(res.status, await explainAdminFailure(res))
      const data = (await res.json()) as VerifyReport
      setReport(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      if (shouldLogAdminClientError(e)) {
        logClientError(e, "admin-verify-schema-failed")
      }
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
