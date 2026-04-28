"use client"

import { Fragment, useEffect, useState } from "react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { logClientError, logClientEvent } from "@/lib/error-tracking/client-logger"

const ROUTE = "/api/admin/family-classification"

interface PendingCluster {
  cluster_id: string
  observation_count: number
  dominant_topic_slug: string | null
  classification_coverage_share: number
  mixed_topic_score: number
  cluster_path: string
}

interface Stats {
  total_clusters: number | null
  without_classification: number | null
  /** Count of family_classifications at the current algorithm version
   *  whose cluster has zero active members — orphans left by a prior
   *  cluster rebuild with redetach. Surfaced as its own tile so
   *  operators can see when the upstream cluster shape moved on. */
  stale_classifications?: number | null
  algorithm_version?: string
  pending?: PendingCluster[]
}

const PENDING_LIST_PAGE_SIZE = 25

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



const QUALITY_ROUTE = "/api/admin/family-classification/quality?limit=200"

type QualityBucket = "safe_to_trust" | "needs_review" | "input_problem"

interface QualityRow {
  cluster_id: string
  quality_bucket: QualityBucket
  family_kind: string | null
  recommended_action: string
  review_reasons: string[]
  quality_reasons: string[]
  classification_coverage_share: number | null
  mixed_topic_score: number | null
  observation_count: number
  llm_status: string | null
  llm_model: string | null
  representative_count: number
  representative_preview: string[]
  common_matched_phrase_count: number
  common_matched_phrase_preview: string[]
  needs_human_review: boolean
  algorithm_version: string | null
  classified_at: string | null
  llm_classified_at: string | null
  updated_at: string | null
}

interface QualitySummary {
  bucket_counts: Record<string, number>
}

interface QualityResponse {
  summary?: Partial<QualitySummary>
  rows?: unknown[]
}

const QUALITY_BUCKET_STYLES: Record<QualityBucket, string> = {
  input_problem: "bg-red-50/70 border-red-300 dark:bg-red-950/20",
  needs_review: "bg-amber-50/70 border-amber-300 dark:bg-amber-950/20",
  safe_to_trust: "bg-green-50/50 border-green-300 dark:bg-green-950/20",
}

const BUCKET_LABELS: Record<QualityBucket, string> = {
  safe_to_trust: "Safe to trust",
  needs_review: "Needs review",
  input_problem: "Input problem",
}

function bucketLabel(bucket: string | null | undefined): string {
  if (bucket === "safe_to_trust" || bucket === "needs_review" || bucket === "input_problem") {
    return BUCKET_LABELS[bucket]
  }
  return "—"
}

// LLM statuses that indicate the LLM step did NOT cleanly succeed. We
// accept multiple vocabularies because the source-of-truth has shifted
// over time: the route's typed enum uses "success"/"error"/"auth_error"/
// "needs_review"/"needs_human_review", but earlier writers used
// "succeeded"/"failed"/"skipped_*"/"low_confidence_fallback". Any
// status not in BAD_LLM_STATUSES and not equal to a success keyword
// counts as a clean run.
const BAD_LLM_STATUSES = new Set<string>([
  "failed",
  "error",
  "auth_error",
  "skipped_missing_api_key",
  "skipped_no_representatives",
  "low_confidence_fallback",
  "needs_review",
  "needs_human_review",
])

function isBadLlmStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return BAD_LLM_STATUSES.has(status)
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

function normalizeBucket(value: unknown): QualityBucket {
  if (value === "safe_to_trust" || value === "needs_review" || value === "input_problem") {
    return value
  }
  return "needs_review"
}

// Tolerate both the current API shape and any near-miss field renames
// (qualityBucket vs quality_bucket, etc.) so the dashboard does not
// silently zero out if the endpoint gets reshaped.
function normalizeQualityRow(input: unknown): QualityRow | null {
  if (!input || typeof input !== "object") return null
  const r = input as Record<string, unknown>
  const cluster_id = asString(r.cluster_id) ?? asString(r.clusterId)
  if (!cluster_id) return null
  return {
    cluster_id,
    quality_bucket: normalizeBucket(r.quality_bucket ?? r.qualityBucket),
    family_kind: asString(r.family_kind) ?? asString(r.familyKind),
    recommended_action:
      asString(r.recommended_action) ?? asString(r.recommendedAction) ?? "",
    review_reasons: asStringArray(r.review_reasons ?? r.reviewReasons),
    quality_reasons: asStringArray(r.quality_reasons ?? r.qualityReasons),
    classification_coverage_share: asNumber(
      r.classification_coverage_share ?? r.classificationCoverageShare,
    ),
    mixed_topic_score: asNumber(r.mixed_topic_score ?? r.mixedTopicScore),
    observation_count: asNumber(r.observation_count ?? r.observationCount) ?? 0,
    llm_status: asString(r.llm_status) ?? asString(r.llmStatus),
    llm_model: asString(r.llm_model) ?? asString(r.llmModel),
    representative_count: asNumber(r.representative_count ?? r.representativeCount) ?? 0,
    representative_preview: asStringArray(r.representative_preview ?? r.representativePreview),
    common_matched_phrase_count:
      asNumber(r.common_matched_phrase_count ?? r.commonMatchedPhraseCount) ?? 0,
    common_matched_phrase_preview: asStringArray(
      r.common_matched_phrase_preview ?? r.commonMatchedPhrasePreview,
    ),
    needs_human_review: r.needs_human_review === true || r.needsHumanReview === true,
    algorithm_version: asString(r.algorithm_version) ?? asString(r.algorithmVersion),
    classified_at: asString(r.classified_at) ?? asString(r.classifiedAt),
    llm_classified_at: asString(r.llm_classified_at) ?? asString(r.llmClassifiedAt),
    updated_at: asString(r.updated_at) ?? asString(r.updatedAt),
  }
}

// Falls back to recomputing bucket counts from rows when the server
// summary is missing or partial. Empty cards driven by a schema
// mismatch are worse than no dashboard.
function deriveBucketCounts(
  summary: Partial<QualitySummary> | undefined,
  rows: QualityRow[],
): Record<string, number> {
  const fromServer = summary?.bucket_counts
  if (fromServer && typeof fromServer === "object") {
    const hasAny = Object.values(fromServer).some((v) => typeof v === "number")
    if (hasAny) return fromServer
  }
  const counts: Record<string, number> = {}
  for (const r of rows) {
    counts[r.quality_bucket] = (counts[r.quality_bucket] ?? 0) + 1
  }
  return counts
}

type BucketFilter = "all" | QualityBucket

const TABLE_COLUMN_COUNT = 9

interface FamilyQualityDashboardProps {
  rows: QualityRow[]
  summary: Partial<QualitySummary>
  loading: boolean
  error: string | null
  bucketFilter: BucketFilter
  onBucketFilterChange: (next: BucketFilter) => void
  expandedRows: Set<string>
  onToggleRow: (clusterId: string) => void
  onRetry: () => void
}

function FamilyQualityDashboard({
  rows,
  summary,
  loading,
  error,
  bucketFilter,
  onBucketFilterChange,
  expandedRows,
  onToggleRow,
  onRetry,
}: FamilyQualityDashboardProps) {
  const bucketCounts = deriveBucketCounts(summary, rows)
  const llmFailedCount = rows.filter((r) => isBadLlmStatus(r.llm_status)).length
  const llmDisagreementCount = rows.filter((r) =>
    r.review_reasons.includes("llm_disagrees_with_heuristic"),
  ).length
  const lowCoverageCount = rows.filter((r) =>
    r.quality_reasons.includes("low_classification_coverage"),
  ).length
  const highMixednessCount = rows.filter((r) =>
    r.quality_reasons.includes("high_topic_mixedness"),
  ).length
  const fallbackPathCount = rows.filter((r) =>
    r.quality_reasons.includes("fallback_cluster_path"),
  ).length

  const filteredRows =
    bucketFilter === "all"
      ? rows
      : rows.filter((r) => r.quality_bucket === bucketFilter)

  return (
    <Card className="border-dashed">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">Read-only quality dashboard</CardTitle>
              <Badge variant="outline" className="text-[10px] font-normal">
                read-only
              </Badge>
            </div>
            <CardDescription>
              Inspect-only diagnostics for already-classified families. This
              section does not run classification or mutate data — it consumes
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[11px]">
                GET /api/admin/family-classification/quality
              </code>
              and groups rows into buckets so you can decide what to review
              before relying on a family for routing or product insight.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Bucket</span>
            <Select
              value={bucketFilter}
              onValueChange={(value) => onBucketFilterChange(value as BucketFilter)}
            >
              <SelectTrigger className="h-8 w-[160px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All buckets</SelectItem>
                <SelectItem value="safe_to_trust">Safe to trust</SelectItem>
                <SelectItem value="needs_review">Needs review</SelectItem>
                <SelectItem value="input_problem">Input problem</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>Could not load family quality data</AlertTitle>
            <AlertDescription className="space-y-2 text-xs">
              <div>{error}</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
                disabled={loading}
                className="h-7 px-2 text-xs"
              >
                {loading ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3 w-3" />
                )}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          <StatTile
            label="Safe to trust"
            value={bucketCounts.safe_to_trust ?? 0}
            hint="Signals look coherent and coverage is acceptable."
          />
          <StatTile
            label="Needs review"
            value={bucketCounts.needs_review ?? 0}
            hint="Usable with caution; inspect rationale before routing."
            emphasis
          />
          <StatTile
            label="Input problem"
            value={bucketCounts.input_problem ?? 0}
            hint="Underlying inputs are likely degraded or sparse."
            emphasis
          />
        </div>

        <div className="grid gap-3 md:grid-cols-5">
          <StatTile label="LLM failed/skipped" value={llmFailedCount} />
          <StatTile label="LLM disagreement" value={llmDisagreementCount} />
          <StatTile label="Low coverage" value={lowCoverageCount} />
          <StatTile label="High mixedness" value={highMixednessCount} />
          <StatTile label="Fallback cluster" value={fallbackPathCount} />
        </div>

        {!error && !loading && rows.length === 0 ? (
          <div className="rounded-md border border-dashed bg-background/50 p-4 text-center text-xs text-muted-foreground">
            No family quality rows found. Run Family Classification backfill
            first, then refresh this dashboard.
          </div>
        ) : null}

        {!error && !loading && rows.length > 0 && filteredRows.length === 0 ? (
          <div className="rounded-md border border-dashed bg-background/50 p-4 text-center text-xs text-muted-foreground">
            No rows match the current bucket filter
            <span className="mx-1 font-medium">{bucketLabel(bucketFilter)}</span>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => onBucketFilterChange("all")}
              className="h-auto px-1 py-0 text-xs"
            >
              Show all
            </Button>
          </div>
        ) : null}

        {filteredRows.length > 0 ? (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quality bucket</TableHead>
                  <TableHead>Cluster ID</TableHead>
                  <TableHead>Family kind</TableHead>
                  <TableHead>LLM status</TableHead>
                  <TableHead>Coverage</TableHead>
                  <TableHead>Mixedness</TableHead>
                  <TableHead>Observations</TableHead>
                  <TableHead>Reps</TableHead>
                  <TableHead>Recommended action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const expanded = expandedRows.has(row.cluster_id)
                  return (
                    <Fragment key={row.cluster_id}>
                      <TableRow
                        className={
                          (QUALITY_BUCKET_STYLES[row.quality_bucket] ?? "") +
                          " cursor-pointer"
                        }
                        onClick={() => onToggleRow(row.cluster_id)}
                      >
                        <TableCell className="font-medium">
                          {bucketLabel(row.quality_bucket)}
                        </TableCell>
                        <TableCell>
                          <code className="rounded bg-muted/60 px-1 py-0.5 text-[11px]">
                            {row.cluster_id.length > 12
                              ? `${row.cluster_id.slice(0, 8)}…`
                              : row.cluster_id}
                          </code>
                        </TableCell>
                        <TableCell>{row.family_kind ?? "—"}</TableCell>
                        <TableCell>{row.llm_status ?? "—"}</TableCell>
                        <TableCell>
                          {formatPct(row.classification_coverage_share)}
                        </TableCell>
                        <TableCell>
                          {row.mixed_topic_score?.toFixed(3) ?? "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatNumber(row.observation_count)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {row.representative_count}
                        </TableCell>
                        <TableCell
                          className="max-w-[16rem] truncate"
                          title={row.recommended_action}
                        >
                          {row.recommended_action || "—"}
                        </TableCell>
                      </TableRow>
                      {expanded ? (
                        <TableRow>
                          <TableCell
                            colSpan={TABLE_COLUMN_COUNT}
                            className="bg-muted/20 text-xs"
                          >
                            <FamilyQualityRowDetails row={row} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading family quality data…
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function FamilyQualityRowDetails({ row }: { row: QualityRow }) {
  return (
    <div className="grid gap-4 py-3 md:grid-cols-2">
      <section className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Why this bucket
        </div>
        <div className="space-y-1">
          <MetricRow label="Bucket" value={bucketLabel(row.quality_bucket)} />
          <MetricRow
            label="Recommended action"
            value={row.recommended_action || "—"}
          />
          <MetricRow
            label="Needs human review"
            value={row.needs_human_review ? "yes" : "no"}
          />
        </div>
        {row.quality_reasons.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Quality reasons
            </div>
            <div className="flex flex-wrap gap-1.5">
              {row.quality_reasons.map((reason) => (
                <Badge
                  key={reason}
                  variant="secondary"
                  className="text-[11px] font-normal"
                >
                  {reason}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
        {row.review_reasons.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Review reasons
            </div>
            <div className="flex flex-wrap gap-1.5">
              {row.review_reasons.map((reason) => (
                <Badge
                  key={reason}
                  variant={
                    reason === "llm_disagrees_with_heuristic"
                      ? "destructive"
                      : "outline"
                  }
                  className="text-[11px] font-normal"
                >
                  {humanizeMachineCode(reason, REVIEW_REASON_LABELS)}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Cluster signals
        </div>
        <div className="grid gap-x-4 gap-y-0 sm:grid-cols-2">
          <MetricRow label="Cluster ID" value={row.cluster_id} />
          <MetricRow label="Family kind" value={row.family_kind ?? "—"} />
          <MetricRow
            label="Coverage"
            value={formatPct(row.classification_coverage_share)}
          />
          <MetricRow
            label="Mixed-topic score"
            value={
              typeof row.mixed_topic_score === "number"
                ? row.mixed_topic_score.toFixed(3)
                : "—"
            }
          />
          <MetricRow
            label="Observations"
            value={formatNumber(row.observation_count)}
          />
          <MetricRow
            label="Representatives"
            value={formatNumber(row.representative_count)}
          />
          <MetricRow
            label="Phrases"
            value={formatNumber(row.common_matched_phrase_count)}
          />
          <MetricRow
            label="Algorithm version"
            value={row.algorithm_version ?? "—"}
          />
          <MetricRow label="LLM status" value={row.llm_status ?? "—"} />
          <MetricRow label="LLM model" value={row.llm_model ?? "—"} />
        </div>
      </section>

      {row.representative_preview.length > 0 ? (
        <section className="space-y-1.5 md:col-span-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Representatives ({row.representative_preview.length} of{" "}
            {row.representative_count})
          </div>
          <ul className="space-y-1">
            {row.representative_preview.map((rep, idx) => (
              <li
                key={`${row.cluster_id}-rep-${idx}`}
                className="rounded-md border bg-background/60 px-2 py-1 text-xs"
              >
                {rep}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {row.common_matched_phrase_preview.length > 0 ? (
        <section className="space-y-1.5 md:col-span-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Common matched phrases ({row.common_matched_phrase_preview.length}{" "}
            of {row.common_matched_phrase_count})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {row.common_matched_phrase_preview.map((phrase, idx) => (
              <Badge
                key={`${row.cluster_id}-phrase-${idx}`}
                variant="outline"
                className="text-[11px] font-normal"
              >
                {phrase}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      <section className="md:col-span-2">
        <details className="rounded-md border bg-background/60 px-2 py-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            Raw row JSON
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-snug">
            {JSON.stringify(row, null, 2)}
          </pre>
        </details>
      </section>
    </div>
  )
}

export function FamilyClassificationPanel({ secret }: { secret: string }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState<string | null>(null)

  const [pendingList, setPendingList] = useState<PendingCluster[]>([])
  const [pendingError, setPendingError] = useState<string | null>(null)
  // cluster_id of the row whose Classify button is currently in flight,
  // null when nothing's running. Single-in-flight is intentional — the
  // whole reason this exists is that batch processing busts the gateway
  // timeout, so firing parallel calls would defeat the point.
  const [pendingRunningId, setPendingRunningId] = useState<string | null>(null)
  const [pendingRowError, setPendingRowError] = useState<{
    cluster_id: string
    message: string
  } | null>(null)

  const [singleClusterId, setSingleClusterId] = useState("")
  const [running, setRunning] = useState<null | "dryRun" | "singleCluster" | "batch">(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<BackfillResult | null>(null)
  const [qualityRows, setQualityRows] = useState<QualityRow[]>([])
  const [qualitySummary, setQualitySummary] = useState<Partial<QualitySummary>>({})
  const [qualityLoading, setQualityLoading] = useState(false)
  const [qualityError, setQualityError] = useState<string | null>(null)
  const [qualityBucketFilter, setQualityBucketFilter] = useState<BucketFilter>("all")
  const [expandedQualityRows, setExpandedQualityRows] = useState<Set<string>>(new Set())

  const loadStats = async () => {
    setStatsLoading(true)
    setStatsError(null)
    setPendingError(null)
    try {
      // ?pending=N piggybacks on the stats call so the panel only does
      // one round-trip on mount/refresh. The server returns the top N
      // unclassified clusters by observation_count.
      const res = await fetch(
        `${ROUTE}?pending=${PENDING_LIST_PAGE_SIZE}`,
        { headers: authHeaders(secret) },
      )
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as Stats
      setStats(data)
      setPendingList(data.pending ?? [])
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setStatsError(message)
      setPendingError(message)
      logClientError(e, "admin-family-classification-stats-failed")
    } finally {
      setStatsLoading(false)
    }
  }

  const loadQuality = async () => {
    setQualityLoading(true)
    setQualityError(null)
    try {
      const res = await fetch(QUALITY_ROUTE, { headers: authHeaders(secret) })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as QualityResponse
      const rawRows = Array.isArray(data.rows) ? data.rows : []
      const normalized = rawRows
        .map(normalizeQualityRow)
        .filter((r): r is QualityRow => r !== null)
      setQualityRows(normalized)
      setQualitySummary(data.summary ?? {})
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setQualityError(message)
      logClientError(e, "admin-family-classification-quality-failed")
    } finally {
      setQualityLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
    loadQuality()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret])

  // Classify a single cluster from the pending list. Reuses the
  // single-cluster POST path so the rich evidence card renders below
  // (same as the manual paste-and-Classify flow). On success the row
  // is dropped from the list and the without_classification stat is
  // optimistically decremented so the UI doesn't need to wait for a
  // round-trip; the next loadStats() reconciles.
  const runFromPending = async (clusterId: string) => {
    if (pendingRunningId || running) return
    setPendingRunningId(clusterId)
    setPendingRowError(null)
    setRunError(null)
    setLastResult(null)
    const startedAt = Date.now()
    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ clusterId, dryRun: false }),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        logClientError(new Error(message), "admin-family-classification-pending-row-failed", {
          cluster_id: clusterId,
          status: res.status,
        })
        throw new Error(message)
      }
      const data = (await res.json()) as BackfillResult
      setLastResult(data)
      setPendingList((current: PendingCluster[]) =>
        current.filter((c: PendingCluster) => c.cluster_id !== clusterId),
      )
      setStats((current: Stats | null) =>
        current
          ? {
              ...current,
              without_classification:
                typeof current.without_classification === "number"
                  ? Math.max(0, current.without_classification - 1)
                  : current.without_classification,
            }
          : current,
      )
      logClientEvent("admin-family-classification-pending-row-succeeded", {
        cluster_id: clusterId,
        family_kind: data.draft?.family_kind,
        durationMs: Date.now() - startedAt,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setPendingRowError({ cluster_id: clusterId, message })
    } finally {
      setPendingRunningId(null)
    }
  }

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
              onClick={() => {
                loadStats()
                loadQuality()
              }}
              disabled={statsLoading || qualityLoading}
            >
              {statsLoading || qualityLoading ? (
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

          <div className="grid gap-3 md:grid-cols-3">
            <StatTile
              label="Total clusters"
              value={stats?.total_clusters}
              hint="All rows in the clusters table — includes historical/dead clusters with no active members. The two tiles to the right are scoped to live clusters only."
              emphasis={false}
            />
            <StatTile
              label="Without classification"
              value={stats?.without_classification}
              emphasis={(stats?.without_classification ?? 0) > 0}
              hint="Live clusters with no current-version classification. Same set the pending list and batch iterate over."
            />
            <StatTile
              label="Pointing to dead clusters"
              value={stats?.stale_classifications ?? null}
              emphasis={(stats?.stale_classifications ?? 0) > 0}
              hint="Classifications whose cluster has 0 active members. Run cluster rebuild → re-classify to clean up."
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
                  disabled={running !== null || pendingRunningId !== null}
                  className="text-sm"
                />
                <Button
                  onClick={runSingleCluster}
                  disabled={
                    running !== null ||
                    pendingRunningId !== null ||
                    !singleClusterId.trim()
                  }
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

          {/* Pending-list browser. Each row classifies a single cluster
              within the gateway timeout — useful when full batch
              classification can't fit in one request (e.g. with slow
              LLM calls). Largest clusters by observation_count first,
              same ordering as the batch path. */}
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground">
                  Pending clusters (one at a time)
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Top {PENDING_LIST_PAGE_SIZE} by observation count. Each
                  classify is a single OpenAI call so it fits inside the
                  request timeout.
                </p>
              </div>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {pendingList.length} shown
                {typeof stats?.without_classification === "number"
                  ? ` of ${stats.without_classification.toLocaleString()} pending`
                  : ""}
              </span>
            </div>

            {pendingError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not load pending clusters</AlertTitle>
                <AlertDescription className="text-xs">{pendingError}</AlertDescription>
              </Alert>
            ) : null}

            {pendingList.length === 0 && !pendingError && !statsLoading ? (
              <div className="rounded-md border border-dashed bg-background/50 p-4 text-center text-xs text-muted-foreground">
                No pending clusters at the current algorithm version.
              </div>
            ) : null}

            {pendingList.length > 0 ? (
              <ul className="space-y-1.5">
                {pendingList.map((row: PendingCluster) => {
                  const isRunning = pendingRunningId === row.cluster_id
                  const rowError =
                    pendingRowError?.cluster_id === row.cluster_id
                      ? pendingRowError.message
                      : null
                  return (
                    <li
                      key={row.cluster_id}
                      className="rounded-md border bg-background/50 p-2 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                          {row.cluster_id}
                        </code>
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {row.observation_count} obs
                        </Badge>
                        {row.dominant_topic_slug ? (
                          <Badge variant="secondary" className="text-[10px] font-normal">
                            {row.dominant_topic_slug}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] font-normal">
                            unclassified
                          </Badge>
                        )}
                        {row.cluster_path === "fallback" ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] font-normal"
                            title="key-based cluster (not embedding-based)"
                          >
                            fallback
                          </Badge>
                        ) : null}
                        <span
                          className="text-[10px] text-muted-foreground tabular-nums"
                          title="classification coverage / mixed-topic score"
                        >
                          cov {Math.round(row.classification_coverage_share * 100)}% · mix{" "}
                          {row.mixed_topic_score.toFixed(2)}
                        </span>
                        <Button
                          onClick={() => runFromPending(row.cluster_id)}
                          disabled={
                            running !== null ||
                            (pendingRunningId !== null && !isRunning)
                          }
                          size="sm"
                          variant="outline"
                          className="ml-auto h-7 px-2 text-xs"
                        >
                          {isRunning ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="mr-1 h-3 w-3" />
                          )}
                          Classify
                        </Button>
                      </div>
                      {rowError ? (
                        <div className="mt-1 text-[11px] text-destructive">
                          {rowError}
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : null}

            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={loadStats}
                disabled={statsLoading || pendingRunningId !== null}
                className="h-7 px-2 text-xs"
              >
                {statsLoading ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3 w-3" />
                )}
                Reload list
              </Button>
              <span className="text-[11px] text-muted-foreground">
                After working through this page, reload to fetch the next
                {" "}
                {PENDING_LIST_PAGE_SIZE}.
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={runDryRun}
              disabled={running !== null || pendingRunningId !== null}
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
              disabled={
                running !== null ||
                pendingRunningId !== null ||
                (stats?.without_classification ?? 0) === 0
              }
            >
              {running === "batch" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              Classify batch
            </Button>
            <p className="text-xs text-muted-foreground">
              Dry run previews how many clusters would be processed.
              Classify batch applies classifications to unclassified
              clusters in one request — for slow OpenAI calls or large
              backlogs, prefer the row-by-row list above.
            </p>
          </div>

          {runError ? (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertTitle>Operation failed</AlertTitle>
              <AlertDescription className="text-xs">{runError}</AlertDescription>
            </Alert>
          ) : null}



          <FamilyQualityDashboard
            rows={qualityRows}
            summary={qualitySummary}
            loading={qualityLoading}
            error={qualityError}
            bucketFilter={qualityBucketFilter}
            onBucketFilterChange={setQualityBucketFilter}
            expandedRows={expandedQualityRows}
            onToggleRow={(clusterId) => {
              setExpandedQualityRows((current) => {
                const next = new Set(current)
                if (next.has(clusterId)) next.delete(clusterId)
                else next.add(clusterId)
                return next
              })
            }}
            onRetry={loadQuality}
          />

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
