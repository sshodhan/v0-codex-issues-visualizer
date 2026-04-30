"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ArrowLeft, CheckCircle2, Flag, Loader2, RefreshCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { logClientError, logClientEvent } from "@/lib/error-tracking/client-logger"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  llmCategoryLabel,
  llmSeverityLabel,
  llmStatusLabel,
} from "@/lib/classification/llm-category-display"
import { familyKindLabel } from "@/lib/classification/family-kind-display"
import { reviewClassification } from "@/hooks/use-dashboard-data"

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
    capture: {
      captured_at: string | null
      published_at: string | null
      source_id: string | null
      source_slug: string | null
      source_name: string | null
    }
    fingerprint: { latest_computed_at: string | null; algorithm_version: string | null; total_versions: number; rows: Array<Record<string, unknown>> }
    embedding: { latest_computed_at: string | null; algorithm_version: string | null; model: string | null; dimensions: number | null; total_versions: number; rows: Array<Record<string, unknown>> }
    category: {
      latest_computed_at: string | null
      algorithm_version: string | null
      winner_slug: string | null
      winner_name: string | null
      confidence: number | null
      evidence: unknown
      total_versions: number
      rows: Array<Record<string, unknown>>
    }
    clustering: {
      active_cluster_id: string | null
      active_cluster_key: string | null
      active_cluster_size: number | null
      active_cluster_label: string | null
      active_cluster_status: string | null
      memberships: Array<Record<string, unknown>>
    }
    classification: { latest_created_at: string | null; latest_algorithm_version: string | null; latest_model_used: string | null; total_versions: number; chain_head_id: string | null; lineage: Array<Record<string, unknown>> }
    family: {
      cluster_id: string | null
      latest_created_at: string | null
      latest_algorithm_version: string | null
      latest_model_used: string | null
      latest_llm_status: string | null
      family_kind: string | null
      family_title: string | null
      family_summary: string | null
      needs_human_review: boolean | null
      review_reasons: unknown
      total_versions: number
    }
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

type RerunStage = "classification" | "embedding"

// Render a timestamp as `Apr 28, 2026, 8:24 AM UTC` (locale-default month/day,
// always UTC) plus the raw ISO string in a tooltip. Keeps trace rows scannable
// while preserving the full-precision value for debugging.
//
// Deliberately deviates from the date-fns `format` / `formatDistanceToNow`
// pattern used elsewhere (e.g. components/dashboard/classification-triage):
// trace data is operational/diagnostic, so timestamps must be unambiguous
// across reviewer locations — UTC is the right default. date-fns v4 doesn't
// support timezone-aware formatting without the extra `date-fns-tz` package
// (not in deps), so Intl.DateTimeFormat is used here. Dashboard cards still
// use date-fns for local time, which is correct for that audience.
function FormattedDate({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span>—</span>
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return <span>{iso}</span>
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)
  return (
    <span title={iso}>
      {formatted} UTC
    </span>
  )
}

function ShortId({ value }: { value: string | null | undefined }) {
  if (!value) return null
  const short = value.length > 12 ? `${value.slice(0, 8)}…` : value
  return (
    <span className="font-mono text-[10px] text-muted-foreground" title={value}>
      {short}
    </span>
  )
}

type MetaValue = ReactNode | string | null

// Maps a card to its place in docs/ARCHITECTURE.md §6.0 "Classification
// improvement pipeline" + the underlying tables. `stageLabel` is the
// human-readable stage prefix shown in the card header (e.g.
// "Stage 4 — Per-observation LLM classification"); `internalRef`
// captures the persistent table names + admin-tab name so the same
// card can be referenced precisely when directing follow-up work to
// engineering ("the bug_fingerprints stage", "the Layer C Backfill
// admin tab"). Both are surfaced as muted subtitles in the header.
interface StageMeta {
  stageLabel: string
  internalRef: string
}

function TraceStage({
  title,
  stage,
  available,
  meta,
  action,
  children,
}: {
  title: string
  stage?: StageMeta
  available: boolean
  meta: Array<[string, MetaValue]>
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          {stage ? (
            <div className="mt-0.5 space-y-0.5 text-[10px] text-muted-foreground">
              <p className="font-medium uppercase tracking-wide">{stage.stageLabel}</p>
              <p className="font-mono">{stage.internalRef}</p>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          <Badge variant={available ? "secondary" : "outline"}>{available ? "available" : "missing"}</Badge>
        </div>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
        {meta.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-baseline gap-1">
            <span className="font-mono text-foreground">{k}</span>
            <span>:</span>
            <span className="break-words">{v ?? "—"}</span>
          </div>
        ))}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  )
}

function RerunButton({
  stage,
  onClick,
  busy,
  disabled,
  hint,
}: {
  stage: RerunStage
  onClick: (stage: RerunStage) => void
  busy: boolean
  disabled?: boolean
  hint?: string
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 px-2 text-xs"
      onClick={() => onClick(stage)}
      disabled={busy || disabled}
      title={hint}
    >
      {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCcw className="mr-1 h-3 w-3" />}
      Re-run
    </Button>
  )
}

export default function ObservationTracePage() {
  const params = useParams()
  const id = Array.isArray(params?.id) ? params.id[0] : (params?.id ?? "")

  const [trace, setTrace] = useState<ObservationTraceResponse | null>(null)
  const [events, setEvents] = useState<ProcessingEventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rerunBusy, setRerunBusy] = useState<RerunStage | null>(null)
  const [rerunStatus, setRerunStatus] = useState<{ stage: RerunStage; ok: boolean; message: string } | null>(null)
  // The classification_reviews table requires reviewed_by (audit trail).
  // We mirror the input pattern in components/dashboard/classification-triage
  // — a free-form text input held in component state, no auth dependency
  // — so reviewers don't need to set up identity to leave feedback from
  // the trace page.
  const [reviewer, setReviewer] = useState<string>("")
  const [reviewBusy, setReviewBusy] = useState<"mark_reviewed" | "flag_review" | null>(null)
  const [reviewStatus, setReviewStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [labelBusy, setLabelBusy] = useState<boolean>(false)
  const [labelStatus, setLabelStatus] = useState<{ ok: boolean; message: string } | null>(null)

  const loadTrace = useCallback(
    async (signal?: AbortSignal, reason: "initial" | "post_rerun" = "initial") => {
      logClientEvent("reviewer-trace-load-started", { observationId: id, reason })

      const [traceRes, classifyRes] = await Promise.all([
        fetch(`/api/observations/${id}/trace`, { signal }),
        fetch(`/api/observations/${id}/classify`, { signal }),
      ])

      if (!traceRes.ok) {
        const text = await traceRes.text().catch(() => "")
        const httpErr = new Error(
          text ? `HTTP ${traceRes.status}: ${text.slice(0, 200)}` : `HTTP ${traceRes.status}`,
        )
        logClientError(httpErr, "reviewer-trace-load-failed", {
          observationId: id,
          reason,
          status: traceRes.status,
        })
        if (traceRes.status === 404) throw new Error("Observation not found.")
        throw httpErr
      }

      const traceBody = (await traceRes.json()) as ObservationTraceResponse
      setTrace(traceBody)
      let eventCount: number | null = null
      if (classifyRes.ok) {
        const body = (await classifyRes.json()) as { trace?: { events?: ProcessingEventItem[] } }
        const eventList = body.trace?.events ?? []
        setEvents(eventList)
        eventCount = eventList.length
      } else {
        logClientError(
          new Error(`HTTP ${classifyRes.status}`),
          "reviewer-trace-classify-companion-failed",
          { observationId: id, reason, status: classifyRes.status },
        )
      }
      logClientEvent("reviewer-trace-load-succeeded", {
        observationId: id,
        reason,
        eventCount,
        availability: traceBody.availability,
      })
    },
    [id],
  )

  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    loadTrace(controller.signal, "initial")
      .catch((e) => {
        if (controller.signal.aborted) return
        const msg = e instanceof Error ? e.message : "Failed to load trace"
        setError(msg)
        // loadTrace already emits reviewer-trace-load-failed for HTTP errors
        // with status context; log here only when the failure didn't go
        // through that path (network / TypeError / unhandled).
        const isHttpError = /^HTTP \d+/.test(msg) || msg === "Observation not found."
        if (!isHttpError) {
          logClientError(e instanceof Error ? e : new Error(msg), "reviewer-trace-load-failed", {
            observationId: id,
            phase: "network_or_unhandled",
          })
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => {
      controller.abort()
    }
  }, [id, loadTrace])

  const handleRerun = useCallback(
    async (stage: RerunStage) => {
      if (!id) return
      setRerunBusy(stage)
      setRerunStatus(null)
      logClientEvent("reviewer-trace-rerun-started", { observationId: id, stage })
      try {
        const res = await fetch(`/api/observations/${id}/rerun`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          error?: string
          detail?: string
          message?: string
          classification_id?: string
          model?: string
          dimensions?: number
        }
        if (!res.ok) {
          const message = body.error || body.message || `HTTP ${res.status}`
          const fullMessage = body.detail ? `${message}: ${body.detail}` : message
          setRerunStatus({ stage, ok: false, message: fullMessage })
          logClientError(new Error(fullMessage), "reviewer-trace-rerun-failed", {
            observationId: id,
            stage,
            status: res.status,
            errorCode: body.error ?? null,
          })
          return
        }
        setRerunStatus({ stage, ok: true, message: `${stage} re-run completed.` })
        logClientEvent("reviewer-trace-rerun-succeeded", {
          observationId: id,
          stage,
          classificationId: body.classification_id ?? null,
          model: body.model ?? null,
          dimensions: body.dimensions ?? null,
        })
        await loadTrace(undefined, "post_rerun").catch((refreshErr) => {
          // The re-run succeeded; refresh failure is non-fatal but worth logging
          // separately so an operator can tell "rerun ok, refresh failed" apart
          // from the rerun itself failing.
          logClientError(
            refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr)),
            "reviewer-trace-rerun-refresh-failed",
            { observationId: id, stage },
          )
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : "Re-run failed"
        setRerunStatus({ stage, ok: false, message })
        logClientError(e instanceof Error ? e : new Error(message), "reviewer-trace-rerun-failed", {
          observationId: id,
          stage,
          phase: "network_or_unhandled",
        })
      } finally {
        setRerunBusy(null)
      }
    },
    [id, loadTrace],
  )

  const handleRecordReview = useCallback(
    async (kind: "mark_reviewed" | "flag_review") => {
      if (!trace) return
      const classificationId = trace.stages.classification.chain_head_id
      if (!classificationId) {
        setReviewStatus({ ok: false, message: "No classification to review yet — run Stage 4 first." })
        return
      }
      const trimmedReviewer = reviewer.trim()
      if (!trimmedReviewer) {
        setReviewStatus({ ok: false, message: "Reviewer name is required for the audit log." })
        return
      }

      setReviewBusy(kind)
      setReviewStatus(null)
      logClientEvent("reviewer-trace-record-review-started", {
        observationId: id,
        kind,
        classificationId,
      })

      try {
        await reviewClassification(classificationId, {
          reviewed_by: trimmedReviewer,
          needs_human_review: kind === "flag_review",
        })
        logClientEvent("reviewer-trace-record-review-succeeded", {
          observationId: id,
          kind,
          classificationId,
        })
        setReviewStatus({
          ok: true,
          message: kind === "flag_review" ? "Flagged for human review." : "Marked reviewed.",
        })
        await loadTrace(undefined, "post_rerun").catch((refreshErr) => {
          logClientError(
            refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr)),
            "reviewer-trace-record-review-refresh-failed",
            { observationId: id, kind, classificationId },
          )
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : "Review failed"
        setReviewStatus({ ok: false, message })
        logClientError(e instanceof Error ? e : new Error(message), "reviewer-trace-record-review-failed", {
          observationId: id,
          kind,
          classificationId,
        })
      } finally {
        setReviewBusy(null)
      }
    },
    [id, loadTrace, reviewer, trace],
  )

  const handleGenerateClusterName = useCallback(
    async (options: { force: boolean }) => {
      if (!trace) return
      const clusterId = trace.stages.clustering.active_cluster_id
      if (!clusterId) {
        setLabelStatus({ ok: false, message: "Observation is not attached to a cluster." })
        return
      }
      setLabelBusy(true)
      setLabelStatus(null)
      logClientEvent("reviewer-trace-generate-cluster-label-started", {
        observationId: id,
        clusterId,
        force: options.force,
      })
      try {
        const res = await fetch(`/api/clusters/${clusterId}/label`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: options.force }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          relabelled?: boolean
          reason?: string
          label?: string
          model?: string
          error?: string
          detail?: string
        }
        if (!res.ok) {
          const message = body.error || `HTTP ${res.status}`
          const fullMessage = body.detail ? `${message}: ${body.detail}` : message
          setLabelStatus({ ok: false, message: fullMessage })
          logClientError(new Error(fullMessage), "reviewer-trace-generate-cluster-label-failed", {
            observationId: id,
            clusterId,
            status: res.status,
            errorCode: body.error ?? null,
          })
          return
        }
        if (body.relabelled === false && body.reason === "cluster_already_labelled") {
          setLabelStatus({
            ok: true,
            message: "Cluster already has a strong label — pass force to regenerate.",
          })
          logClientEvent("reviewer-trace-generate-cluster-label-skipped", {
            observationId: id,
            clusterId,
            reason: body.reason,
          })
          return
        }
        setLabelStatus({
          ok: true,
          message: body.label ? `New label: ${body.label}` : "Cluster relabelled.",
        })
        logClientEvent("reviewer-trace-generate-cluster-label-succeeded", {
          observationId: id,
          clusterId,
          label: body.label ?? null,
          model: body.model ?? null,
          force: options.force,
        })
        await loadTrace(undefined, "post_rerun").catch((refreshErr) => {
          logClientError(
            refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr)),
            "reviewer-trace-generate-cluster-label-refresh-failed",
            { observationId: id, clusterId },
          )
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : "Cluster label trigger failed"
        setLabelStatus({ ok: false, message })
        logClientError(
          e instanceof Error ? e : new Error(message),
          "reviewer-trace-generate-cluster-label-failed",
          { observationId: id, clusterId, phase: "network_or_unhandled" },
        )
      } finally {
        setLabelBusy(false)
      }
    },
    [id, loadTrace, trace],
  )

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="container mx-auto flex items-center gap-3 py-4">
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <div className="h-6 w-px bg-border" />
          <h1 className="text-lg font-semibold">Cross-layer Observation Trace</h1>
          {id ? <span className="font-mono text-xs text-muted-foreground">{id}</span> : null}
        </div>
      </header>

      <main className="container mx-auto max-w-3xl py-8 space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading trace…
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTitle>Trace load failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : trace ? (
          <>
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{trace.observation.title}</p>
              <p className="text-xs text-muted-foreground">{trace.observation.observation_id}</p>
              {trace.observation.url ? (
                <a
                  className="text-xs text-primary hover:underline"
                  href={trace.observation.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open source URL
                </a>
              ) : null}
            </div>

            {rerunStatus ? (
              <Alert variant={rerunStatus.ok ? "default" : "destructive"}>
                <AlertTitle>
                  Re-run {rerunStatus.stage} {rerunStatus.ok ? "succeeded" : "failed"}
                </AlertTitle>
                <AlertDescription>{rerunStatus.message}</AlertDescription>
              </Alert>
            ) : null}

            <TraceStage
              title="Capture"
              stage={{
                stageLabel: "Raw observation · precedes Stage 1",
                internalRef: "observations / observation_revisions",
              }}
              available={trace.availability.capture}
              meta={[
                ["captured_at", <FormattedDate key="captured" iso={trace.stages.capture.captured_at} />],
                ["published_at", <FormattedDate key="published" iso={trace.stages.capture.published_at} />],
                [
                  "source",
                  trace.stages.capture.source_name || trace.stages.capture.source_slug ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-foreground">
                        {trace.stages.capture.source_name ?? trace.stages.capture.source_slug}
                      </span>
                      {trace.stages.capture.source_slug && trace.stages.capture.source_name ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          ({trace.stages.capture.source_slug})
                        </span>
                      ) : null}
                      <ShortId value={trace.stages.capture.source_id} />
                    </span>
                  ) : (
                    <ShortId value={trace.stages.capture.source_id} />
                  ),
                ],
              ]}
            />
            <TraceStage
              title="Bug fingerprint (regex)"
              stage={{
                stageLabel: "Stage 1 · regex + deterministic signals",
                internalRef: "bug_fingerprints · admin: Layer 0 Backfill",
              }}
              available={trace.availability.fingerprint}
              meta={[
                ["algorithm_version", trace.stages.fingerprint.algorithm_version],
                ["latest_computed_at", <FormattedDate key="fp" iso={trace.stages.fingerprint.latest_computed_at} />],
                ["versions", String(trace.stages.fingerprint.total_versions)],
              ]}
            />
            <TraceStage
              title="Embedding"
              stage={{
                stageLabel: "Stage 2 · embeddings",
                internalRef: "observation_embeddings · admin: Layer A Clustering",
              }}
              available={trace.availability.embedding}
              action={
                <RerunButton
                  stage="embedding"
                  busy={rerunBusy === "embedding"}
                  onClick={handleRerun}
                  hint="Re-call the OpenAI embeddings API and overwrite the stored vector."
                />
              }
              meta={[
                ["algorithm_version", trace.stages.embedding.algorithm_version],
                ["model", trace.stages.embedding.model],
                [
                  "dimensions",
                  trace.stages.embedding.dimensions === null ? null : String(trace.stages.embedding.dimensions),
                ],
                ["latest_computed_at", <FormattedDate key="emb" iso={trace.stages.embedding.latest_computed_at} />],
              ]}
            />
            <TraceStage
              title="Topic (regex_topic)"
              stage={{
                stageLabel: "Stage 1 · regex topic classifier",
                internalRef: "category_assignments · admin: Layer 0 Backfill",
              }}
              available={trace.availability.category}
              meta={[
                ["algorithm_version", trace.stages.category.algorithm_version],
                [
                  "winner",
                  trace.stages.category.winner_name || trace.stages.category.winner_slug ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-foreground">
                        {trace.stages.category.winner_name ?? trace.stages.category.winner_slug}
                      </span>
                      {trace.stages.category.winner_slug ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          ({trace.stages.category.winner_slug})
                        </span>
                      ) : null}
                    </span>
                  ) : null,
                ],
                [
                  "confidence",
                  trace.stages.category.confidence === null ? null : trace.stages.category.confidence.toFixed(2),
                ],
                ["latest_computed_at", <FormattedDate key="cat" iso={trace.stages.category.latest_computed_at} />],
                ["versions", String(trace.stages.category.total_versions)],
              ]}
            >
              {trace.stages.category.evidence ? (
                <pre className="overflow-x-auto rounded bg-muted p-2 text-[10px]">
                  {JSON.stringify(trace.stages.category.evidence, null, 2)}
                </pre>
              ) : null}
            </TraceStage>
            <TraceStage
              title="Cluster membership"
              stage={{
                stageLabel: "Stage 3 · clustering",
                internalRef: "cluster_members / clusters · admin: Layer A Clustering",
              }}
              available={trace.availability.clustering}
              meta={[
                [
                  "active_cluster",
                  trace.stages.clustering.active_cluster_label || trace.stages.clustering.active_cluster_key ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-foreground">
                        {trace.stages.clustering.active_cluster_label ??
                          trace.stages.clustering.active_cluster_key}
                      </span>
                      {trace.stages.clustering.active_cluster_label &&
                      trace.stages.clustering.active_cluster_key ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          ({trace.stages.clustering.active_cluster_key})
                        </span>
                      ) : null}
                      <ShortId value={trace.stages.clustering.active_cluster_id} />
                    </span>
                  ) : (
                    <ShortId value={trace.stages.clustering.active_cluster_id} />
                  ),
                ],
                ["status", trace.stages.clustering.active_cluster_status],
                [
                  "active_cluster_size",
                  trace.stages.clustering.active_cluster_size === null
                    ? null
                    : String(trace.stages.clustering.active_cluster_size),
                ],
                ["memberships", String(trace.stages.clustering.memberships.length)],
              ]}
            >
              {trace.stages.clustering.active_cluster_id ? (
                <div className="space-y-2 rounded border bg-muted/40 p-2 text-xs">
                  <p className="text-muted-foreground">
                    {trace.stages.clustering.active_cluster_label
                      ? "Cluster has a name. Use Force regenerate to relabel from current cluster contents."
                      : "Cluster has no name yet. Trigger the deterministic labeller to compose one from the cluster's Topic + canonical title + recurring error code."}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 px-2 text-xs"
                      onClick={() => handleGenerateClusterName({ force: false })}
                      disabled={labelBusy || Boolean(trace.stages.clustering.active_cluster_label)}
                      title="Compose a deterministic label only when the cluster has none / weak. No OpenAI call."
                    >
                      {labelBusy ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCcw className="mr-1 h-3 w-3" />
                      )}
                      Generate cluster name
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 px-2 text-xs"
                      onClick={() => handleGenerateClusterName({ force: true })}
                      disabled={labelBusy}
                      title="Force regenerate the deterministic label even if a strong one already exists."
                    >
                      {labelBusy ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCcw className="mr-1 h-3 w-3" />
                      )}
                      Force regenerate
                    </Button>
                  </div>
                  {labelStatus ? (
                    <p className={labelStatus.ok ? "text-foreground" : "text-destructive"}>
                      {labelStatus.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </TraceStage>
            <TraceStage
              title="Per-observation LLM classification"
              stage={{
                stageLabel: "Stage 4 · per-observation LLM classification (not family)",
                internalRef: "classifications · admin: Layer C Backfill",
              }}
              available={trace.availability.classification}
              action={
                <RerunButton
                  stage="classification"
                  busy={rerunBusy === "classification"}
                  onClick={handleRerun}
                  hint="Append a fresh LLM classification to the chain."
                />
              }
              meta={[
                ["latest_model", trace.stages.classification.latest_model_used],
                ["latest_algorithm", trace.stages.classification.latest_algorithm_version],
                [
                  "latest_created_at",
                  <FormattedDate key="cls" iso={trace.stages.classification.latest_created_at} />,
                ],
                ["versions", String(trace.stages.classification.total_versions)],
              ]}
            >
              {trace.stages.classification.lineage.length > 0 ? (
                <div className="space-y-2">
                  {trace.stages.classification.lineage.map((node, idx) => {
                    const rawCategory = node.category == null ? null : String(node.category)
                    const rawSeverity = node.severity == null ? null : String(node.severity)
                    const rawStatus = node.status == null ? null : String(node.status)
                    const subcategory = node.subcategory == null ? null : String(node.subcategory)
                    return (
                      <div key={String(node.id)} className="rounded border bg-muted/40 p-2 text-xs">
                        <p className="font-mono text-[10px] text-muted-foreground" title={String(node.id)}>
                          {String(node.id)}
                        </p>
                        <p className="font-medium text-foreground">
                          {rawCategory ? llmCategoryLabel(rawCategory) : "Unknown category"}
                          {" · "}
                          {llmSeverityLabel(rawSeverity)}
                          {" · "}
                          {llmStatusLabel(rawStatus)}
                          {idx === 0 ? <span className="ml-1 text-muted-foreground">(head)</span> : null}
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {[rawCategory, rawSeverity, rawStatus].filter(Boolean).join(" · ") || "—"}
                          {subcategory ? ` · sub:${subcategory}` : ""}
                        </p>
                        <p className="text-muted-foreground">
                          prior:{" "}
                          {node.prior_classification_id ? (
                            <ShortId value={String(node.prior_classification_id)} />
                          ) : (
                            "none"
                          )}
                        </p>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </TraceStage>
            <TraceStage
              title="Cluster family"
              stage={{
                stageLabel: "Stage 4 · cluster-level family interpretation",
                internalRef: "family_classifications · admin: Family Classification",
              }}
              available={trace.availability.family}
              meta={[
                [
                  "family_kind",
                  trace.stages.family.family_kind ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-foreground">
                        {familyKindLabel(trace.stages.family.family_kind)}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        ({trace.stages.family.family_kind})
                      </span>
                    </span>
                  ) : null,
                ],
                ["needs_human_review", trace.stages.family.needs_human_review === null ? null : String(trace.stages.family.needs_human_review)],
                ["latest_model", trace.stages.family.latest_model_used],
                ["latest_algorithm", trace.stages.family.latest_algorithm_version],
                ["llm_status", trace.stages.family.latest_llm_status],
                [
                  "latest_created_at",
                  <FormattedDate key="fam" iso={trace.stages.family.latest_created_at} />,
                ],
                ["versions", String(trace.stages.family.total_versions)],
              ]}
            >
              {trace.stages.family.family_title || trace.stages.family.family_summary ? (
                <div className="space-y-1 rounded border bg-muted/40 p-2 text-xs">
                  {trace.stages.family.family_title ? (
                    <p className="font-medium text-foreground">
                      {trace.stages.family.family_title}
                    </p>
                  ) : null}
                  {trace.stages.family.family_summary ? (
                    <p className="text-muted-foreground">{trace.stages.family.family_summary}</p>
                  ) : null}
                </div>
              ) : !trace.availability.family && trace.stages.clustering.active_cluster_id ? (
                <p className="rounded border bg-muted/40 p-2 text-xs text-muted-foreground">
                  No family_classifications row yet for this cluster. Family naming runs from the
                  Family Classification admin tab once the cluster has enough signal.
                </p>
              ) : null}
            </TraceStage>
            <TraceStage
              title="Reviewer feedback"
              stage={{
                stageLabel: "Stage 5 · human-in-the-loop",
                internalRef: "classification_reviews / topic_review_events · admin: Stage 5: Topic Review",
              }}
              available={trace.availability.review}
              meta={[
                ["total_reviews", String(trace.stages.review.total_reviews)],
                [
                  "latest_reviewed_at",
                  <FormattedDate key="rev" iso={trace.stages.review.latest_reviewed_at} />,
                ],
                ["generated_at", <FormattedDate key="gen" iso={trace.generated_at} />],
              ]}
            >
              <div className="space-y-2 rounded border bg-muted/40 p-2 text-xs">
                <p className="text-muted-foreground">
                  {trace.stages.classification.chain_head_id
                    ? "Append a row to classification_reviews (audit-only; the LLM baseline stays immutable)."
                    : "No Stage 4 classification yet — re-run the Classification chain above before recording a review."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={reviewer}
                    onChange={(event) => setReviewer(event.target.value)}
                    placeholder="Your name (required for audit log)"
                    className="h-8 max-w-xs text-xs"
                    disabled={reviewBusy !== null}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    onClick={() => handleRecordReview("mark_reviewed")}
                    disabled={
                      reviewBusy !== null ||
                      !trace.stages.classification.chain_head_id ||
                      reviewer.trim().length === 0
                    }
                    title="Record a passing review (needs_human_review = false)."
                  >
                    {reviewBusy === "mark_reviewed" ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                    )}
                    Mark reviewed
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    onClick={() => handleRecordReview("flag_review")}
                    disabled={
                      reviewBusy !== null ||
                      !trace.stages.classification.chain_head_id ||
                      reviewer.trim().length === 0
                    }
                    title="Flag this classification as needing human review."
                  >
                    {reviewBusy === "flag_review" ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Flag className="mr-1 h-3 w-3" />
                    )}
                    Flag for review
                  </Button>
                </div>
                {reviewStatus ? (
                  <p
                    className={
                      reviewStatus.ok ? "text-foreground" : "text-destructive"
                    }
                  >
                    {reviewStatus.message}
                  </p>
                ) : null}
              </div>
            </TraceStage>

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
                        <FormattedDate iso={event.created_at} />
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
          </>
        ) : null}
      </main>
    </div>
  )
}
