"use client"

import { useEffect, useState } from "react"
import { CircleCheck, Loader2, Play, RefreshCw, TestTube2, TriangleAlert, XCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { logClientError, logClientEvent } from "@/lib/error-tracking/client-logger"

const ROUTE = "/api/admin/family-classification"

interface Stats {
  total_clusters: number | null
  without_classification: number | null
  algorithm_version?: string
}

// Mirrors lib/storage/family-classification.ts → FamilyClassificationDraft.
// Kept as a JSON-shape interface here (loose) so the panel doesn't have
// to import a server-only module. Anything missing is rendered as "—".
interface FamilyDraft {
  cluster_id: string
  algorithm_version: string
  family_title: string
  family_summary: string
  family_kind: string
  dominant_topic_slug: string | null
  primary_failure_mode: string | null
  affected_surface: string | null
  likely_owner_area: string | null
  severity_rollup: string
  confidence: number
  needs_human_review: boolean
  review_reasons: string[]
  evidence: FamilyEvidence
}

interface FamilyEvidence {
  cluster_topic_metadata?: {
    cluster_path?: string
    observation_count?: number
    classified_count?: number
    classification_coverage_share?: number
    dominant_topic_slug?: string | null
    dominant_topic_share?: number
    mixed_topic_score?: number
    low_margin_count?: number
    low_margin_share?: number
    avg_confidence_proxy?: number | null
    common_matched_phrases?: Array<{ slug: string; phrase: string; count: number }>
  }
  representatives?: Array<{
    observation_id: string
    title: string
    body_snippet: string | null
    topic_slug: string | null
    is_canonical: boolean
  }>
  llm?: {
    status: string
    prompt_template_version: string
    model: string | null
    request_id: string | null
    latency_ms: number | null
    confidence: number | null
    rationale: string | null
    suggested_family_kind: string | null
  }
}

interface BackfillResult {
  dryRun: boolean
  candidates: number
  classified: number
  failed: number
  wouldProcess: number
  draft?: FamilyDraft
}

// Display-string maps for machine codes that otherwise render as
// snake_case in the admin UI. Keeping these here (not in the server
// module) so display-string churn doesn't ripple into evidence rows.
const FAMILY_KIND_LABELS: Record<string, string> = {
  coherent_single_issue: "Coherent",
  mixed_multi_causal: "Mixed (multi-causal)",
  needs_split_review: "Needs split review",
  low_evidence: "Low evidence",
  unclear: "Unclear",
}

const REVIEW_REASON_LABELS: Record<string, string> = {
  low_classification_coverage: "Low classification coverage",
  high_topic_mixedness: "High topic mixedness",
  many_close_topic_calls: "Many close topic calls",
  mixed_or_unclear_signals: "Mixed/unclear signals",
  fallback_cluster_path: "Fallback cluster path",
  low_avg_layer0_confidence: "Low avg Layer 0 confidence",
  llm_disagrees_with_heuristic: "LLM disagrees with heuristic",
}

const LLM_STATUS_LABELS: Record<string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  skipped_missing_api_key: "Skipped — no API key",
  skipped_no_representatives: "Skipped — no representatives",
  low_confidence_fallback: "Low confidence — used fallback",
}

function humanizeMachineCode(code: string, labels: Record<string, string>): string {
  return labels[code] ?? code
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(0)}%`
}

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return value.toLocaleString()
}

function familyKindBadgeVariant(
  kind: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (kind === "coherent_single_issue") return "default"
  if (kind === "low_evidence" || kind === "needs_split_review") return "destructive"
  if (kind === "unclear") return "secondary"
  return "outline"
}

function llmStatusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "default"
  if (status === "failed") return "destructive"
  return "outline"
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

// Compact key/value row used for the signals grid. Keeps numbers
// right-aligned with tabular figures so reviewers can compare across
// rows without their eyes drifting.
function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1 last:border-b-0">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-xs font-medium tabular-nums">{value}</span>
    </div>
  )
}

// Renders the full evidence payload from a single-cluster classify
// response. Intentionally one component (not many) so reviewers see
// title, summary, signals, phrases, representatives, and LLM status
// in one scannable block.
function FamilyEvidenceCard({ draft, dryRun }: { draft: FamilyDraft; dryRun: boolean }) {
  const meta = draft.evidence.cluster_topic_metadata ?? {}
  const reps = draft.evidence.representatives ?? []
  const phrases = meta.common_matched_phrases ?? []
  const llm = draft.evidence.llm

  const dominantSlug = draft.dominant_topic_slug ?? meta.dominant_topic_slug ?? null
  const llmDisagrees =
    llm?.suggested_family_kind != null &&
    llm.suggested_family_kind !== draft.family_kind

  return (
    <Card className="border-blue-600/40 bg-blue-50/30 dark:bg-blue-950/20">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={familyKindBadgeVariant(draft.family_kind)}>
            {humanizeMachineCode(draft.family_kind, FAMILY_KIND_LABELS)}
          </Badge>
          {draft.needs_human_review ? (
            <Badge variant="destructive" className="gap-1">
              <TriangleAlert className="h-3 w-3" />
              Needs review
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <CircleCheck className="h-3 w-3" />
              Auto-classified
            </Badge>
          )}
          <Badge variant="outline">
            confidence {formatPct(draft.confidence)}
          </Badge>
          {dryRun ? (
            <Badge variant="secondary">Dry run — not persisted</Badge>
          ) : null}
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            algorithm {draft.algorithm_version}
          </span>
        </div>
        <CardTitle className="text-base leading-tight">{draft.family_title}</CardTitle>
        <CardDescription className="text-xs leading-relaxed">
          {draft.family_summary}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Review reasons */}
        {draft.review_reasons.length > 0 ? (
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Review reasons
            </div>
            <div className="flex flex-wrap gap-1.5">
              {draft.review_reasons.map((r) => (
                <Badge
                  key={r}
                  variant={r === "llm_disagrees_with_heuristic" ? "destructive" : "secondary"}
                  className="text-[11px] font-normal"
                >
                  {humanizeMachineCode(r, REVIEW_REASON_LABELS)}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {/* Mechanism fields (LLM-derived) */}
        {(draft.primary_failure_mode ||
          draft.affected_surface ||
          draft.likely_owner_area ||
          dominantSlug) ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {dominantSlug ? (
              <MetricRow label="Dominant topic" value={dominantSlug} />
            ) : null}
            {draft.primary_failure_mode ? (
              <MetricRow label="Failure mode" value={draft.primary_failure_mode} />
            ) : null}
            {draft.affected_surface ? (
              <MetricRow label="Affected surface" value={draft.affected_surface} />
            ) : null}
            {draft.likely_owner_area ? (
              <MetricRow label="Likely owner" value={draft.likely_owner_area} />
            ) : null}
          </div>
        ) : null}

        {/* Layer A signals grid */}
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Layer A signals
          </div>
          <div className="grid gap-x-4 gap-y-0 sm:grid-cols-2">
            <MetricRow label="Observations" value={formatNumber(meta.observation_count)} />
            <MetricRow
              label="Coverage"
              value={formatPct(meta.classification_coverage_share)}
            />
            <MetricRow
              label="Dominant share"
              value={formatPct(meta.dominant_topic_share)}
            />
            <MetricRow
              label="Mixed-topic score"
              value={
                typeof meta.mixed_topic_score === "number"
                  ? meta.mixed_topic_score.toFixed(3)
                  : "—"
              }
            />
            <MetricRow
              label="Low-margin members"
              value={
                meta.low_margin_count != null
                  ? `${formatNumber(meta.low_margin_count)} (${formatPct(meta.low_margin_share)})`
                  : "—"
              }
            />
            <MetricRow
              label="Avg Layer 0 confidence"
              value={
                typeof meta.avg_confidence_proxy === "number"
                  ? meta.avg_confidence_proxy.toFixed(3)
                  : "—"
              }
            />
            <MetricRow label="Cluster path" value={meta.cluster_path ?? "—"} />
          </div>
        </div>

        {/* Common matched phrases */}
        {phrases.length > 0 ? (
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Common matched phrases
            </div>
            <div className="flex flex-wrap gap-1.5">
              {phrases.slice(0, 8).map((p, idx) => (
                <Badge
                  key={`${p.slug}-${p.phrase}-${idx}`}
                  variant="outline"
                  className="text-[11px] font-normal"
                  title={`${p.slug} (${p.count}×)`}
                >
                  &ldquo;{p.phrase}&rdquo;
                  <span className="ml-1 text-muted-foreground">×{p.count}</span>
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {/* Representatives */}
        {reps.length > 0 ? (
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Representative reports ({reps.length})
            </div>
            <ul className="space-y-2">
              {reps.map((r) => (
                <li
                  key={r.observation_id}
                  className="rounded-md border bg-background/50 p-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.is_canonical ? (
                      <Badge variant="default" className="text-[10px] font-normal">
                        canonical
                      </Badge>
                    ) : null}
                    {r.topic_slug ? (
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {r.topic_slug}
                      </Badge>
                    ) : null}
                    <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      {r.observation_id}
                    </code>
                  </div>
                  <div className="mt-1 font-medium">{r.title}</div>
                  {r.body_snippet ? (
                    <p className="mt-1 text-muted-foreground line-clamp-3">
                      {r.body_snippet}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* LLM block */}
        {llm ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                LLM
              </span>
              <Badge
                variant={llmStatusBadgeVariant(llm.status)}
                className="text-[10px] font-normal"
              >
                {humanizeMachineCode(llm.status, LLM_STATUS_LABELS)}
              </Badge>
              {llm.suggested_family_kind ? (
                <Badge
                  variant={llmDisagrees ? "destructive" : "outline"}
                  className="text-[10px] font-normal"
                  title={
                    llmDisagrees
                      ? "Disagrees with heuristic — heuristic kept; flagged for review"
                      : "Agrees with heuristic"
                  }
                >
                  suggests:{" "}
                  {humanizeMachineCode(llm.suggested_family_kind, FAMILY_KIND_LABELS)}
                </Badge>
              ) : null}
            </div>
            {llm.rationale ? (
              <p className="rounded-md border bg-background/50 p-2 text-xs italic text-muted-foreground">
                &ldquo;{llm.rationale}&rdquo;
              </p>
            ) : null}
            <div className="grid gap-x-4 gap-y-0 sm:grid-cols-2">
              <MetricRow label="Model" value={llm.model ?? "—"} />
              <MetricRow
                label="Latency"
                value={
                  typeof llm.latency_ms === "number" ? `${llm.latency_ms} ms` : "—"
                }
              />
              <MetricRow
                label="LLM confidence"
                value={
                  typeof llm.confidence === "number" ? formatPct(llm.confidence) : "—"
                }
              />
              <MetricRow
                label="Prompt template"
                value={llm.prompt_template_version}
              />
              {llm.request_id ? (
                <MetricRow label="Request ID" value={llm.request_id} />
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
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
                Heuristic-authoritative cluster interpretation. The
                deterministic rules decide{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">family_kind</code>{" "}
                and review requirements; the LLM enriches title/summary and
                flags disagreement but never overrides the heuristic.
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
              emphasis={false}
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
            <div className="space-y-3">
              {/* Counts summary — always shown so batch/dryRun runs still
                  surface candidate/classified/failed totals. */}
              <Alert className="border-blue-600/40 bg-blue-50/40 dark:bg-blue-950/20">
                <AlertTitle>
                  {lastResult.dryRun
                    ? "Dry run complete"
                    : lastResult.draft
                      ? "Cluster classified"
                      : "Batch classification complete"}
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

              {/* Rich evidence display — single-cluster classify (dryRun
                  or apply) returns the full draft. Batch returns no
                  draft, so this only renders for the single-cluster
                  path, which is exactly when a reviewer needs to
                  inspect the result before trusting it. */}
              {lastResult.draft ? (
                <FamilyEvidenceCard
                  draft={lastResult.draft}
                  dryRun={lastResult.dryRun}
                />
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
