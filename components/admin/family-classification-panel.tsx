"use client"

import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { CircleCheck, Loader2, Play, RefreshCw, Square, TestTube2, TriangleAlert, XCircle } from "lucide-react"

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
import { Textarea } from "@/components/ui/textarea"
import {
  type BucketFilter,
  type QualityBucket,
  type QualityResponse,
  type QualityRow,
  type QualitySummary,
  deriveBucketCounts,
  filterRowsByBucket,
  isBadLlmStatus,
  normalizeQualityRow,
} from "@/lib/admin/family-classification-quality-ui"
import {
  ERROR_REASONS,
  ERROR_SOURCES,
  FAMILY_KIND_VALUES,
  REVIEW_DECISIONS,
  buildFamilyReviewEvidenceSnapshot,
  type ErrorReason,
  type ErrorSource,
  type FamilyKind as ReviewFamilyKind,
  type FamilyReviewSummary,
  type ReviewDecision,
} from "@/lib/admin/family-classification-review"
import { logClientError, logClientEvent } from "@/lib/error-tracking/client-logger"
import { runWorkerPool } from "@/lib/admin/run-worker-pool"

const ROUTE = "/api/admin/family-classification"
const REVIEW_ROUTE = "/api/admin/family-classification/review"

// Display labels for the QA-review machine codes. Kept colocated with
// the panel so display-string churn doesn't ripple into the validator
// module.
const REVIEW_VERDICT_LABELS: Record<string, string> = {
  correct: "Correct",
  incorrect: "Incorrect",
  unclear: "Unclear",
}

const ERROR_SOURCE_LABELS: Record<string, string> = {
  stage_1_regex_topic: "Stage 1 — regex / topic",
  stage_2_embedding: "Stage 2 — embedding",
  stage_3_clustering: "Stage 3 — clustering",
  stage_4_llm_classification: "Stage 4 — LLM classification",
  stage_4_family_naming: "Stage 4 — family naming",
  stage_4_fallback: "Stage 4 — deterministic fallback",
  stage_5_review_workflow: "Stage 5 — review workflow",
  representative_selection: "Representative selection",
  data_quality: "Data quality",
  unknown: "Unknown",
}

const ERROR_REASON_LABELS: Record<string, string> = {
  wrong_family_kind: "Wrong family kind",
  bad_family_title: "Bad family title",
  bad_family_summary: "Bad family summary",
  bad_representatives: "Bad representatives",
  bad_cluster_membership: "Bad cluster membership",
  llm_hallucinated: "LLM hallucinated",
  llm_too_generic: "LLM too generic",
  heuristic_overrode_better_llm_answer: "Heuristic overrode better LLM answer",
  llm_disagreed_but_was_wrong: "LLM disagreed but was wrong",
  low_evidence_should_not_be_coherent: "Low evidence — should not be coherent",
  general_feedback_not_actionable: "General feedback — not actionable",
  singleton_not_recurring: "Singleton (not recurring)",
  mixed_cluster_should_split: "Mixed cluster — should split",
  false_safe_to_trust: "False safe-to-trust",
  false_needs_review: "False needs-review",
  false_input_problem: "False input-problem",
  other: "Other",
}

const REVIEW_DECISION_LABELS: Record<string, string> = {
  accept_heuristic: "Accept heuristic",
  accept_llm: "Accept LLM suggestion",
  override_family_kind: "Override family kind",
  mark_low_evidence: "Mark as low evidence",
  mark_general_feedback: "Mark as general feedback",
  needs_more_examples: "Needs more examples",
  should_split_cluster: "Should split cluster",
  not_actionable: "Not actionable",
}

const FAMILY_KIND_REVIEW_LABELS: Record<string, string> = {
  coherent_single_issue: "Coherent",
  mixed_multi_causal: "Mixed (multi-causal)",
  needs_split_review: "Needs split review",
  low_evidence: "Low evidence",
  unclear: "Unclear",
}

interface LatestReview {
  id: string
  classification_id: string
  cluster_id: string
  review_verdict: string
  review_decision: string | null
  expected_family_kind: string | null
  actual_family_kind: string | null
  quality_bucket: string | null
  error_source: string | null
  error_reason: string | null
  notes: string | null
  reviewed_by: string | null
  reviewed_at: string
  evidence_snapshot: Record<string, unknown> | null
}

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

// Drain backlog: fire single-cluster POSTs with a small worker pool.
// Concurrency 3 keeps OpenAI rate-limit risk low while staying ~3x
// faster than serial. Page size matches PENDING_MAX_LIMIT on the
// server (`/api/admin/family-classification` route). The route's
// bulk path is fundamentally fragile (50 × 10s OpenAI calls in a for
// loop exceeds Vercel's 300s function cap); this drains by reusing
// the single-cluster path, which finishes in ~10-15s per cluster.
const DRAIN_CONCURRENCY = 3
const DRAIN_PAGE_SIZE = 100
// Stop the drain after this many consecutive failures so a broken
// upstream (e.g. OpenAI outage) doesn't burn the whole backlog.
// "Consecutive" means uninterrupted in completion order across all
// in-flight workers — with concurrency > 1, a slow success completing
// after a fast failure resets the counter. That's intentional: any
// sign of life from the upstream takes the breaker off the hook.
const DRAIN_MAX_CONSECUTIVE_FAILURES = 3

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

const TABLE_COLUMN_COUNT = 10

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
  latestReviewByClassification: Record<string, LatestReview>
  reviewSummary: FamilyReviewSummary | null
  reviewSummaryLoading: boolean
  reviewSummaryError: string | null
  onSubmitReview: (input: ReviewSubmitInput) => Promise<{ ok: boolean; error?: string }>
}

interface ReviewSubmitInput {
  row: QualityRow
  reviewVerdict: "correct" | "incorrect" | "unclear"
  reviewDecision?: ReviewDecision
  expectedFamilyKind?: ReviewFamilyKind
  errorSource?: ErrorSource
  errorReason?: ErrorReason
  notes?: string
}

// Detects rows where heuristic and LLM disagreed and the dashboard
// wants the reviewer to make an explicit tie-break call. Scoped tightly
// to actual disagreement signals so the amber "Human tie-break needed"
// box doesn't appear on every needs_review row:
//   * `llm_disagrees_with_heuristic` review reason — the canonical
//     signal written by the classifier when the two suggest different
//     family_kinds;
//   * `llm_suggested_family_kind` differs from the stored
//     `family_kind` — same disagreement seen directly, used as a
//     belt-and-suspenders check in case the review_reason wasn't set
//     (e.g. older classifications or the LLM's status was non-success
//     but it still emitted a suggested kind).
// "Needs review" rows that aren't a heuristic-vs-LLM split are still
// reviewable via the verdict buttons; they just don't get the dedicated
// tie-break section.
function isTieBreakRow(row: QualityRow): boolean {
  if (row.review_reasons.includes("llm_disagrees_with_heuristic")) return true
  if (
    row.llm_suggested_family_kind != null &&
    row.family_kind != null &&
    row.llm_suggested_family_kind !== row.family_kind
  ) {
    return true
  }
  return false
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
  latestReviewByClassification,
  reviewSummary,
  reviewSummaryLoading,
  reviewSummaryError,
  onSubmitReview,
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

  const filteredRows = filterRowsByBucket(rows, bucketFilter)

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
        <ReviewSummaryCard
          summary={reviewSummary}
          loading={reviewSummaryLoading}
          error={reviewSummaryError}
        />

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
                  <TableHead>Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const expanded = expandedRows.has(row.cluster_id)
                  const latestReview = row.classification_id
                    ? latestReviewByClassification[row.classification_id] ?? null
                    : null
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
                        <TableCell>
                          <ReviewVerdictBadge review={latestReview} />
                        </TableCell>
                      </TableRow>
                      {expanded ? (
                        <TableRow>
                          <TableCell
                            colSpan={TABLE_COLUMN_COUNT}
                            className="bg-muted/20 text-xs"
                          >
                            <FamilyQualityRowDetails
                              row={row}
                              latestReview={
                                row.classification_id
                                  ? latestReviewByClassification[
                                      row.classification_id
                                    ] ?? null
                                  : null
                              }
                              onSubmitReview={onSubmitReview}
                            />
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

function FamilyQualityRowDetails({
  row,
  latestReview,
  onSubmitReview,
}: {
  row: QualityRow
  latestReview: LatestReview | null
  onSubmitReview: (input: ReviewSubmitInput) => Promise<{ ok: boolean; error?: string }>
}) {
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
        <ReviewFormPanel
          row={row}
          latestReview={latestReview}
          onSubmitReview={onSubmitReview}
        />
      </section>

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

function reviewVerdictBadgeVariant(
  verdict: string | null | undefined,
): "default" | "secondary" | "destructive" | "outline" {
  if (verdict === "correct") return "default"
  if (verdict === "incorrect") return "destructive"
  if (verdict === "unclear") return "secondary"
  return "outline"
}

function ReviewVerdictBadge({ review }: { review: LatestReview | null }) {
  if (!review) {
    return (
      <span className="text-[10px] text-muted-foreground">—</span>
    )
  }
  return (
    <Badge
      variant={reviewVerdictBadgeVariant(review.review_verdict)}
      className="text-[10px] font-normal"
      title={`reviewed_at ${review.reviewed_at}`}
    >
      {humanizeMachineCode(review.review_verdict, REVIEW_VERDICT_LABELS)}
    </Badge>
  )
}

// Inline review form. Lives inside the expanded Family Quality row so
// reviewers don't lose the evidence context while choosing a verdict.
// The three verdict buttons toggle which auxiliary fields render below.
//
// Submit semantics (mirrored on the server):
//   * correct: error_source/error_reason are forced to null; one POST.
//   * incorrect: requires error_source + error_reason; if error_reason
//     is wrong_family_kind, also requires expected_family_kind.
//   * unclear: notes optional, nothing else required.
//   * review_decision (independent of verdict): override_family_kind
//     also requires expected_family_kind; mark_low_evidence implies
//     expected_family_kind = low_evidence on the server.
//
// On submit success the form switches to a success message and the
// row's main "Review" pill flips to the new verdict — but the row
// stays in the dashboard. There is no file/dismiss/defer flow.
function ReviewFormPanel({
  row,
  latestReview,
  onSubmitReview,
}: {
  row: QualityRow
  latestReview: LatestReview | null
  onSubmitReview: (input: ReviewSubmitInput) => Promise<{ ok: boolean; error?: string }>
}) {
  const [verdict, setVerdict] = useState<"correct" | "incorrect" | "unclear" | null>(null)
  const [reviewDecision, setReviewDecision] = useState<string>("")
  const [expectedFamilyKind, setExpectedFamilyKind] = useState<string>("")
  const [errorSource, setErrorSource] = useState<string>("")
  const [errorReason, setErrorReason] = useState<string>("")
  const [notes, setNotes] = useState<string>("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitOk, setSubmitOk] = useState(false)

  const disabled = !row.classification_id
  const tieBreakNeeded = isTieBreakRow(row)

  const reset = () => {
    setVerdict(null)
    setReviewDecision("")
    setExpectedFamilyKind("")
    setErrorSource("")
    setErrorReason("")
    setNotes("")
    setSubmitError(null)
  }

  const requiresWrongKind = errorReason === "wrong_family_kind"
  const decisionRequiresExpectedKind = reviewDecision === "override_family_kind"

  // Mirrors the server-side tie-break contract: when heuristic and LLM
  // disagreed, the reviewer cannot mark the row "correct" while also
  // saying "accept_llm". The Stage 5 → Stage 4 feedback signal would
  // otherwise be ambiguous for the Improvement Workbench.
  const correctAcceptLlmContradiction =
    verdict === "correct" &&
    reviewDecision === "accept_llm" &&
    row.llm_suggested_family_kind != null &&
    row.family_kind != null &&
    row.llm_suggested_family_kind !== row.family_kind

  // Mirrors the server-side should_split_cluster constraint.
  const splitClusterErrorSourceInvalid =
    reviewDecision === "should_split_cluster" &&
    errorSource !== "" &&
    errorSource !== "stage_3_clustering" &&
    errorSource !== "representative_selection"

  const canSubmit = (() => {
    if (!verdict || disabled || submitting) return false
    if (verdict === "incorrect") {
      if (!errorSource || !errorReason) return false
      if (requiresWrongKind && !expectedFamilyKind) return false
    }
    if (decisionRequiresExpectedKind && !expectedFamilyKind) return false
    if (correctAcceptLlmContradiction) return false
    if (splitClusterErrorSourceInvalid) return false
    return true
  })()

  const submit = async () => {
    if (!verdict) return
    setSubmitting(true)
    setSubmitError(null)
    setSubmitOk(false)
    const payload: ReviewSubmitInput = {
      row,
      reviewVerdict: verdict,
      ...(reviewDecision
        ? { reviewDecision: reviewDecision as ReviewDecision }
        : {}),
      ...(expectedFamilyKind
        ? { expectedFamilyKind: expectedFamilyKind as ReviewFamilyKind }
        : {}),
      ...(verdict === "incorrect"
        ? {
            errorSource: errorSource as ErrorSource,
            errorReason: errorReason as ErrorReason,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          }
        : verdict === "unclear"
          ? notes.trim()
            ? { notes: notes.trim() }
            : {}
          : {}),
    }
    try {
      const result = await onSubmitReview(payload)
      if (!result.ok) {
        setSubmitError(result.error ?? "Failed to submit review")
        return
      }
      setSubmitOk(true)
      reset()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-background/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Review classification quality
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Append-only feedback. Does not change the classification or
            its quality bucket — feeds future precision/recall analysis.
          </p>
        </div>
        {latestReview ? (
          <div className="text-[11px] text-muted-foreground">
            <span className="mr-1">Latest:</span>
            <Badge
              variant={reviewVerdictBadgeVariant(latestReview.review_verdict)}
              className="text-[10px] font-normal"
            >
              {humanizeMachineCode(latestReview.review_verdict, REVIEW_VERDICT_LABELS)}
            </Badge>{" "}
            <span className="tabular-nums">
              {new Date(latestReview.reviewed_at).toLocaleString()}
            </span>
            {latestReview.reviewed_by ? (
              <span className="ml-1">· {latestReview.reviewed_by}</span>
            ) : null}
            {latestReview.review_decision ? (
              <span className="ml-1">
                · decision{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                  {humanizeMachineCode(
                    latestReview.review_decision,
                    REVIEW_DECISION_LABELS,
                  )}
                </code>
              </span>
            ) : null}
            {latestReview.error_source ? (
              <span className="ml-1">
                · source{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                  {humanizeMachineCode(latestReview.error_source, ERROR_SOURCE_LABELS)}
                </code>
              </span>
            ) : null}
            {latestReview.error_reason ? (
              <span className="ml-1">
                · reason{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                  {humanizeMachineCode(latestReview.error_reason, ERROR_REASON_LABELS)}
                </code>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {disabled ? (
        <Alert variant="destructive">
          <AlertTitle className="text-xs">Cannot review this row</AlertTitle>
          <AlertDescription className="text-[11px]">
            No classification_id is associated with this row. Re-run the
            quality endpoint or re-classify this cluster before
            submitting a review.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={verdict === "correct" ? "default" : "outline"}
          onClick={() => {
            setVerdict("correct")
            setSubmitOk(false)
            setSubmitError(null)
          }}
          disabled={disabled || submitting}
          className="h-7 px-2 text-xs"
        >
          Correct
        </Button>
        <Button
          type="button"
          size="sm"
          variant={verdict === "incorrect" ? "destructive" : "outline"}
          onClick={() => {
            setVerdict("incorrect")
            setSubmitOk(false)
            setSubmitError(null)
          }}
          disabled={disabled || submitting}
          className="h-7 px-2 text-xs"
        >
          Incorrect
        </Button>
        <Button
          type="button"
          size="sm"
          variant={verdict === "unclear" ? "secondary" : "outline"}
          onClick={() => {
            setVerdict("unclear")
            setSubmitOk(false)
            setSubmitError(null)
          }}
          disabled={disabled || submitting}
          className="h-7 px-2 text-xs"
        >
          Unclear
        </Button>
      </div>

      {verdict === "incorrect" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-[11px]">
            <span className="uppercase tracking-wide text-muted-foreground">
              Error source<span className="text-destructive"> *</span>
            </span>
            <Select value={errorSource} onValueChange={setErrorSource}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select error source (stage)" />
              </SelectTrigger>
              <SelectContent>
                {ERROR_SOURCES.map((source) => (
                  <SelectItem key={source} value={source}>
                    {humanizeMachineCode(source, ERROR_SOURCE_LABELS)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-[11px]">
            <span className="uppercase tracking-wide text-muted-foreground">
              Error reason<span className="text-destructive"> *</span>
            </span>
            <Select value={errorReason} onValueChange={setErrorReason}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select error reason" />
              </SelectTrigger>
              <SelectContent>
                {ERROR_REASONS.map((reason) => (
                  <SelectItem key={reason} value={reason}>
                    {humanizeMachineCode(reason, ERROR_REASON_LABELS)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {requiresWrongKind ? (
            <label className="space-y-1 text-[11px] sm:col-span-2">
              <span className="uppercase tracking-wide text-muted-foreground">
                Expected family kind<span className="text-destructive"> *</span>
              </span>
              <Select
                value={expectedFamilyKind}
                onValueChange={setExpectedFamilyKind}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select expected family kind" />
                </SelectTrigger>
                <SelectContent>
                  {FAMILY_KIND_VALUES.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {humanizeMachineCode(kind, FAMILY_KIND_REVIEW_LABELS)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <label className="space-y-1 text-[11px] sm:col-span-2">
            <span className="uppercase tracking-wide text-muted-foreground">
              Notes (optional)
            </span>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What went wrong? Anything the next reviewer should know."
              className="min-h-[60px] text-xs"
            />
          </label>
        </div>
      ) : null}

      {/* Human tie-break section. Visible only when heuristic and LLM
          disagreed (canonical `llm_disagrees_with_heuristic` review
          reason or directly comparing family_kind vs
          llm_suggested_family_kind). accept_heuristic / accept_llm pair
          naturally with "correct" / "incorrect" verdicts but the form
          does not enforce — the dashboard shows summary breakdowns
          either way. */}
      {tieBreakNeeded && verdict ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-50/40 p-2 dark:bg-amber-950/20">
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-3 w-3 text-amber-600" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Human tie-break
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Heuristic and LLM disagreed on the family kind. Record which
            side you took so future precision/recall tiles can split by
            tie-break outcome.
          </p>
          {row.family_kind || row.llm_suggested_family_kind ? (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">heuristic:</span>
              <Badge variant="outline" className="text-[10px] font-normal">
                {row.family_kind
                  ? humanizeMachineCode(row.family_kind, FAMILY_KIND_REVIEW_LABELS)
                  : "—"}
              </Badge>
              <span className="text-muted-foreground">LLM:</span>
              <Badge variant="outline" className="text-[10px] font-normal">
                {row.llm_suggested_family_kind
                  ? humanizeMachineCode(
                      row.llm_suggested_family_kind,
                      FAMILY_KIND_REVIEW_LABELS,
                    )
                  : "—"}
              </Badge>
            </div>
          ) : null}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-[11px]">
              <span className="uppercase tracking-wide text-muted-foreground">
                Decision
              </span>
              <Select value={reviewDecision} onValueChange={setReviewDecision}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select review decision" />
                </SelectTrigger>
                <SelectContent>
                  {REVIEW_DECISIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {humanizeMachineCode(d, REVIEW_DECISION_LABELS)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {decisionRequiresExpectedKind ? (
              <label className="space-y-1 text-[11px]">
                <span className="uppercase tracking-wide text-muted-foreground">
                  Expected family kind<span className="text-destructive"> *</span>
                </span>
                <Select
                  value={expectedFamilyKind}
                  onValueChange={setExpectedFamilyKind}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select expected family kind" />
                  </SelectTrigger>
                  <SelectContent>
                    {FAMILY_KIND_VALUES.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {humanizeMachineCode(kind, FAMILY_KIND_REVIEW_LABELS)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      {verdict === "unclear" ? (
        <label className="space-y-1 text-[11px]">
          <span className="uppercase tracking-wide text-muted-foreground">
            Notes (optional)
          </span>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why is this unclear? What additional context would resolve it?"
            className="min-h-[60px] text-xs"
          />
        </label>
      ) : null}

      {correctAcceptLlmContradiction ? (
        <Alert variant="destructive">
          <AlertTitle className="text-xs">Contract mismatch</AlertTitle>
          <AlertDescription className="text-[11px]">
            &ldquo;Correct&rdquo; with &ldquo;Accept LLM suggestion&rdquo;
            isn&rsquo;t allowed when heuristic and LLM disagreed on the
            family kind — pick &ldquo;Incorrect&rdquo; instead.
          </AlertDescription>
        </Alert>
      ) : null}

      {splitClusterErrorSourceInvalid ? (
        <Alert variant="destructive">
          <AlertTitle className="text-xs">Error source mismatch</AlertTitle>
          <AlertDescription className="text-[11px]">
            &ldquo;Should split cluster&rdquo; only blames Stage 3
            (clustering) or representative selection. Pick one of those.
          </AlertDescription>
        </Alert>
      ) : null}

      {verdict ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={!canSubmit}
            className="h-7 px-2 text-xs"
          >
            {submitting ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            Submit review
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={reset}
            disabled={submitting}
            className="h-7 px-2 text-xs"
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {submitError ? (
        <Alert variant="destructive">
          <AlertTitle className="text-xs">Could not submit review</AlertTitle>
          <AlertDescription className="text-[11px]">
            {submitError}
          </AlertDescription>
        </Alert>
      ) : null}

      {submitOk ? (
        <Alert className="border-green-600/40 bg-green-50/40 dark:bg-green-950/20">
          <AlertTitle className="text-xs">Review recorded</AlertTitle>
          <AlertDescription className="text-[11px]">
            Saved as an append-only review. The classification and its
            quality bucket are unchanged.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

// Read-only summary card for the Family Quality section. Tiles are
// directional, not statistically significant — labelled as such so an
// operator with three reviews doesn't read precision = 1.0 as a
// production guarantee.
function ReviewSummaryCard({
  summary,
  loading,
  error,
}: {
  summary: FamilyReviewSummary | null
  loading: boolean
  error: string | null
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load review summary</AlertTitle>
        <AlertDescription className="text-xs">{error}</AlertDescription>
      </Alert>
    )
  }

  if (!summary || summary.reviewed_count === 0) {
    return (
      <div className="rounded-md border border-dashed bg-background/40 p-3 text-[11px] text-muted-foreground">
        <div className="font-semibold uppercase tracking-wide">
          QA review summary
        </div>
        <div className="mt-1">
          {loading
            ? "Loading review summary…"
            : "Not enough reviewed rows yet."}
        </div>
      </div>
    )
  }

  const formatPrecision = (value: number | null): string => {
    if (value == null || !Number.isFinite(value)) return "—"
    return `${(value * 100).toFixed(0)}%`
  }

  return (
    <div className="rounded-md border bg-background/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            QA review summary
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Directional precision/recall signal — small samples are not
            statistically significant. Latest review per classification.
          </p>
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {summary.reviewed_count} reviewed
        </span>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-4">
        <StatTile
          label="Reviewed"
          value={summary.reviewed_count}
          hint="Distinct classifications with at least one review."
        />
        <StatTile
          label="Correct"
          value={summary.correct_count}
        />
        <StatTile
          label="Incorrect"
          value={summary.incorrect_count}
          emphasis={summary.incorrect_count > 0}
        />
        <StatTile
          label="Unclear"
          value={summary.unclear_count}
        />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">
            Safe-to-trust precision
          </div>
          <div className="text-xl font-semibold tabular-nums">
            {formatPrecision(summary.safe_to_trust_precision)}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {summary.safe_to_trust_correct} correct of{" "}
            {summary.safe_to_trust_reviewed} reviewed in{" "}
            <code className="rounded bg-muted px-1">safe_to_trust</code>.
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">
            Needs-review correct
          </div>
          <div className="text-xl font-semibold tabular-nums">
            {summary.needs_review_correct}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            of {summary.needs_review_reviewed} reviewed. High → possible
            over-flagging by the dashboard.
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">
            Input-problem confirmed
          </div>
          <div className="text-xl font-semibold tabular-nums">
            {summary.input_problem_confirmed}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            of {summary.input_problem_reviewed} reviewed. Reviewer
            agreed the inputs were degraded.
          </div>
        </div>
      </div>

      {summary.top_error_source || summary.top_error_reason ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-md border p-3 text-xs">
            <div className="text-muted-foreground">Top error source</div>
            <div className="mt-1 font-medium">
              {summary.top_error_source
                ? humanizeMachineCode(
                    summary.top_error_source,
                    ERROR_SOURCE_LABELS,
                  )
                : "—"}
            </div>
          </div>
          <div className="rounded-md border p-3 text-xs">
            <div className="text-muted-foreground">Top error reason</div>
            <div className="mt-1 font-medium">
              {summary.top_error_reason
                ? humanizeMachineCode(
                    summary.top_error_reason,
                    ERROR_REASON_LABELS,
                  )
                : "—"}
            </div>
          </div>
        </div>
      ) : null}

      {summary.tie_break_reviewed_count > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Review decisions ({summary.tie_break_reviewed_count})
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <StatTile
              label="Heuristic accepted"
              value={summary.heuristic_accepted_count}
              hint="Reviewer agreed with the heuristic's stored kind."
            />
            <StatTile
              label="LLM accepted"
              value={summary.llm_accepted_count}
              hint="Reviewer agreed with the LLM's suggestion."
            />
            <StatTile
              label="Family kind overridden"
              value={summary.override_family_kind_count}
              hint="Reviewer set a different family_kind than either side."
            />
            <StatTile
              label="Low evidence"
              value={summary.low_evidence_override_count}
              hint="Marked low_evidence regardless of suggested kind."
            />
            <StatTile
              label="General feedback"
              value={summary.general_feedback_marked_count}
              hint="Not actionable as a single issue family."
            />
            <StatTile
              label="Needs more examples"
              value={summary.needs_more_examples_count}
              hint="Reviewer wants more reps before deciding."
            />
            <StatTile
              label="Should split cluster"
              value={summary.should_split_cluster_count}
              hint="Cluster contains multiple distinct issues."
            />
            <StatTile
              label="Not actionable"
              value={summary.not_actionable_count}
              hint="Issue exists but no useful follow-up."
            />
          </div>
        </div>
      ) : null}
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
  const [running, setRunning] = useState<null | "dryRun" | "singleCluster" | "batch" | "drain">(null)
  const [drainProgress, setDrainProgress] = useState<{
    pageTotal: number
    pageSucceeded: number
    pageFailed: number
    inFlight: number
    cumulativeSucceeded: number
    cumulativeFailed: number
  } | null>(null)
  // Drain cancellation. The AbortController feeds into runWorkerPool,
  // which checks signal.aborted before scheduling each new worker.
  // Mirror the cancelling state into useState as well so the Stop
  // button + "cancelling…" hint re-render the moment the user clicks
  // (refs alone don't trigger re-render).
  const drainAbortRef = useRef<AbortController | null>(null)
  const [aborting, setAborting] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<BackfillResult | null>(null)
  const [qualityRows, setQualityRows] = useState<QualityRow[]>([])
  const [qualitySummary, setQualitySummary] = useState<Partial<QualitySummary>>({})
  const [qualityLoading, setQualityLoading] = useState(false)
  const [qualityError, setQualityError] = useState<string | null>(null)
  const [qualityBucketFilter, setQualityBucketFilter] = useState<BucketFilter>("all")
  const [expandedQualityRows, setExpandedQualityRows] = useState<Set<string>>(new Set())
  // Latest review per classification_id — drives the row pill and the
  // "Latest" line above the form. Refetched alongside the summary on
  // every panel refresh and after each successful submit.
  const [latestReviewByClassification, setLatestReviewByClassification] =
    useState<Record<string, LatestReview>>({})
  const [reviewSummary, setReviewSummary] = useState<FamilyReviewSummary | null>(null)
  const [reviewSummaryLoading, setReviewSummaryLoading] = useState(false)
  const [reviewSummaryError, setReviewSummaryError] = useState<string | null>(null)

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

  const loadReviews = useCallback(async () => {
    setReviewSummaryLoading(true)
    setReviewSummaryError(null)
    try {
      const res = await fetch(`${REVIEW_ROUTE}?limit=200`, {
        headers: authHeaders(secret),
      })
      if (!res.ok) throw new Error(await explainAdminFailure(res))
      const data = (await res.json()) as {
        rows?: LatestReview[]
        summary?: FamilyReviewSummary
      }
      const map: Record<string, LatestReview> = {}
      for (const row of data.rows ?? []) {
        if (row?.classification_id) map[row.classification_id] = row
      }
      setLatestReviewByClassification(map)
      setReviewSummary(data.summary ?? null)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setReviewSummaryError(message)
      logClientError(e, "admin-family-classification-reviews-failed")
    } finally {
      setReviewSummaryLoading(false)
    }
  }, [secret])

  const submitReview = useCallback(
    async (input: ReviewSubmitInput): Promise<{ ok: boolean; error?: string }> => {
      const {
        row,
        reviewVerdict,
        reviewDecision,
        expectedFamilyKind,
        errorSource,
        errorReason,
        notes,
      } = input
      if (!row.classification_id) {
        return { ok: false, error: "Row is missing classification_id" }
      }
      const evidenceSnapshot = buildFamilyReviewEvidenceSnapshot({
        classification_id: row.classification_id,
        cluster_id: row.cluster_id,
        family_title: row.family_title,
        family_summary: row.family_summary,
        family_kind: row.family_kind,
        quality_bucket: row.quality_bucket,
        quality_reasons: row.quality_reasons,
        recommended_action: row.recommended_action,
        confidence: row.confidence,
        needs_human_review: row.needs_human_review,
        review_reasons: row.review_reasons,
        representative_count: row.representative_count,
        representative_preview: row.representative_preview,
        common_matched_phrase_count: row.common_matched_phrase_count,
        common_matched_phrase_preview: row.common_matched_phrase_preview,
        review_decision: reviewDecision ?? null,
        llm_suggested_family_kind: row.llm_suggested_family_kind,
      })

      try {
        const res = await fetch(REVIEW_ROUTE, {
          method: "POST",
          headers: authHeaders(secret),
          body: JSON.stringify({
            classificationId: row.classification_id,
            clusterId: row.cluster_id,
            reviewVerdict,
            reviewDecision,
            expectedFamilyKind,
            actualFamilyKind: row.family_kind,
            // Validator uses this to enforce the tie-break contract.
            llmSuggestedFamilyKind: row.llm_suggested_family_kind,
            qualityBucket: row.quality_bucket,
            errorSource,
            errorReason,
            notes,
            evidenceSnapshot,
          }),
        })
        if (!res.ok) {
          let message: string
          try {
            const body = (await res.json()) as { error?: string; details?: unknown }
            message = body.error
              ? Array.isArray(body.details)
                ? `${body.error}: ${(body.details as string[]).join("; ")}`
                : body.error
              : await explainAdminFailure(res)
          } catch {
            message = await explainAdminFailure(res)
          }
          logClientError(new Error(message), "admin-family-classification-review-submit-failed", {
            classification_id: row.classification_id,
            cluster_id: row.cluster_id,
            review_verdict: reviewVerdict,
          })
          return { ok: false, error: message }
        }
        logClientEvent("admin-family-classification-review-submit-succeeded", {
          classification_id: row.classification_id,
          cluster_id: row.cluster_id,
          review_verdict: reviewVerdict,
          review_decision: reviewDecision,
          error_source: errorSource,
          error_reason: errorReason,
        })
        await loadReviews()
        return { ok: true }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { ok: false, error: message }
      }
    },
    [secret, loadReviews],
  )

  useEffect(() => {
    loadStats()
    loadQuality()
    loadReviews()
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

  // Drain the backlog by paging through pending clusters and firing
  // single-cluster POSTs through runWorkerPool at concurrency
  // DRAIN_CONCURRENCY. Each request is bounded by the same timing as
  // a manual single-cluster classify (~10-15s), so no individual call
  // can hit the function timeout — the original bulk POST's serial
  // for-loop did. cancelDrain() aborts the controller; the worker
  // pool stops scheduling and resolves once in-flight workers settle.
  const runDrain = async () => {
    if (running) return
    setRunning("drain")
    setRunError(null)
    setLastResult(null)
    setAborting(false)
    const controller = new AbortController()
    drainAbortRef.current = controller
    setDrainProgress({
      pageTotal: 0,
      pageSucceeded: 0,
      pageFailed: 0,
      inFlight: 0,
      cumulativeSucceeded: 0,
      cumulativeFailed: 0,
    })
    const startedAt = Date.now()
    let cumulativeSucceeded = 0
    let cumulativeFailed = 0
    let breakerTripped = false

    const classifyOne = async (clusterId: string): Promise<boolean> => {
      const r = await fetch(ROUTE, {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({ clusterId, dryRun: false }),
      })
      return r.ok
    }

    try {
      while (!controller.signal.aborted) {
        const pageRes = await fetch(`${ROUTE}?pending=${DRAIN_PAGE_SIZE}`, {
          headers: authHeaders(secret),
        })
        if (!pageRes.ok) throw new Error(await explainAdminFailure(pageRes))
        const pageData = (await pageRes.json()) as Stats
        const page = pageData.pending ?? []
        if (page.length === 0) break

        const result = await runWorkerPool({
          queue: page.map((p) => p.cluster_id),
          worker: classifyOne,
          concurrency: DRAIN_CONCURRENCY,
          maxConsecutiveFailures: DRAIN_MAX_CONSECUTIVE_FAILURES,
          signal: controller.signal,
          onProgress: (p) => {
            setDrainProgress({
              pageTotal: page.length,
              pageSucceeded: p.succeeded,
              pageFailed: p.failed,
              inFlight: p.inFlight,
              cumulativeSucceeded: cumulativeSucceeded + p.succeeded,
              cumulativeFailed: cumulativeFailed + p.failed,
            })
          },
        })

        cumulativeSucceeded += result.succeeded
        cumulativeFailed += result.failed

        if (result.consecutiveFailureLimitReached) {
          breakerTripped = true
          break
        }
        if (result.aborted) break
      }

      if (breakerTripped) {
        throw new Error(
          `Stopped after ${DRAIN_MAX_CONSECUTIVE_FAILURES} consecutive failures — ` +
            "check Vercel logs and OpenAI status, then retry.",
        )
      }

      logClientEvent("admin-family-classification-drain-succeeded", {
        succeeded: cumulativeSucceeded,
        failed: cumulativeFailed,
        aborted: controller.signal.aborted,
        durationMs: Date.now() - startedAt,
      })
      await loadStats()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setRunError(message)
      logClientError(e, "admin-family-classification-drain-failed", {
        succeeded: cumulativeSucceeded,
        failed: cumulativeFailed,
      })
      // Reconcile what did land before the failure.
      await loadStats().catch(() => undefined)
    } finally {
      setRunning(null)
      setDrainProgress(null)
      setAborting(false)
      drainAbortRef.current = null
    }
  }

  const cancelDrain = () => {
    if (!drainAbortRef.current) return
    drainAbortRef.current.abort()
    setAborting(true)
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
                loadReviews()
              }}
              disabled={statsLoading || qualityLoading || reviewSummaryLoading}
            >
              {statsLoading || qualityLoading || reviewSummaryLoading ? (
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
            {running === "drain" ? (
              <Button
                type="button"
                variant="destructive"
                onClick={cancelDrain}
                disabled={aborting}
              >
                <Square className="mr-1 h-4 w-4" />
                {aborting ? "Stopping…" : "Stop drain"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={runDrain}
                disabled={
                  running !== null ||
                  pendingRunningId !== null ||
                  (stats?.without_classification ?? 0) === 0
                }
              >
                <Play className="mr-1 h-4 w-4" />
                Drain backlog ({DRAIN_CONCURRENCY}× parallel)
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Dry run previews how many clusters would be processed.
              Classify batch is a single bulk request (small backlogs only).
              Drain backlog fires single-cluster classifies in parallel —
              the right tool for large backlogs because each request
              stays well under the function timeout.
            </p>
          </div>

          {drainProgress ? (
            <Alert>
              <Loader2 className="h-4 w-4 animate-spin" />
              <AlertTitle>Draining backlog</AlertTitle>
              <AlertDescription className="text-xs">
                Page: {drainProgress.pageSucceeded + drainProgress.pageFailed} /
                {" "}{drainProgress.pageTotal}
                {" • "}
                Succeeded: {drainProgress.cumulativeSucceeded}
                {" • "}
                Failed: {drainProgress.cumulativeFailed}
                {" • "}
                In flight: {drainProgress.inFlight}
                {aborting ? " • cancelling…" : null}
              </AlertDescription>
            </Alert>
          ) : null}

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
            latestReviewByClassification={latestReviewByClassification}
            reviewSummary={reviewSummary}
            reviewSummaryLoading={reviewSummaryLoading}
            reviewSummaryError={reviewSummaryError}
            onSubmitReview={submitReview}
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
