"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ArrowLeft, Loader2, RefreshCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { logClientError } from "@/lib/error-tracking/client-logger"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

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
    category: { latest_computed_at: string | null; algorithm_version: string | null; winner_slug: string | null; confidence: number | null; evidence: unknown; total_versions: number; rows: Array<Record<string, unknown>> }
    clustering: {
      active_cluster_id: string | null
      active_cluster_key: string | null
      active_cluster_size: number | null
      active_cluster_label: string | null
      active_cluster_status: string | null
      memberships: Array<Record<string, unknown>>
    }
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

type RerunStage = "classification" | "embedding"

// Render a timestamp as `Apr 28, 2026, 8:24 AM UTC` (locale-default month/day,
// always UTC) plus the raw ISO string in a tooltip. Keeps trace rows scannable
// while preserving the full-precision value for debugging.
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

function TraceStage({
  title,
  available,
  meta,
  action,
  children,
}: {
  title: string
  available: boolean
  meta: Array<[string, MetaValue]>
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <div className="flex items-center gap-2">
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

  const loadTrace = useCallback(
    async (signal?: AbortSignal) => {
      const [traceRes, classifyRes] = await Promise.all([
        fetch(`/api/observations/${id}/trace`, { signal }),
        fetch(`/api/observations/${id}/classify`, { signal }),
      ])

      if (!traceRes.ok) {
        if (traceRes.status === 404) {
          throw new Error("Observation not found.")
        }
        const text = await traceRes.text().catch(() => "")
        const msg = text ? `HTTP ${traceRes.status}: ${text.slice(0, 200)}` : `HTTP ${traceRes.status}`
        throw new Error(msg)
      }

      const traceBody = (await traceRes.json()) as ObservationTraceResponse
      setTrace(traceBody)
      if (classifyRes.ok) {
        const body = (await classifyRes.json()) as { trace?: { events?: ProcessingEventItem[] } }
        setEvents(body.trace?.events ?? [])
      }
    },
    [id],
  )

  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    loadTrace(controller.signal)
      .catch((e) => {
        if (controller.signal.aborted) return
        const msg = e instanceof Error ? e.message : "Failed to load trace"
        setError(msg)
        logClientError(e instanceof Error ? e : new Error(msg), "reviewer-trace-fetch-failed", {
          observationId: id,
        })
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
      try {
        const res = await fetch(`/api/observations/${id}/rerun`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage }),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; message?: string }
        if (!res.ok) {
          const message = body.error || body.message || `HTTP ${res.status}`
          setRerunStatus({ stage, ok: false, message: body.detail ? `${message}: ${body.detail}` : message })
          return
        }
        setRerunStatus({ stage, ok: true, message: `${stage} re-run completed.` })
        await loadTrace().catch(() => {
          // The re-run succeeded; a refresh failure is non-fatal — surface it but keep the success status.
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : "Re-run failed"
        setRerunStatus({ stage, ok: false, message })
        logClientError(e instanceof Error ? e : new Error(message), "reviewer-trace-rerun-failed", {
          observationId: id,
          stage,
        })
      } finally {
        setRerunBusy(null)
      }
    },
    [id, loadTrace],
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
              title="Fingerprint"
              available={trace.availability.fingerprint}
              meta={[
                ["algorithm_version", trace.stages.fingerprint.algorithm_version],
                ["latest_computed_at", <FormattedDate key="fp" iso={trace.stages.fingerprint.latest_computed_at} />],
                ["versions", String(trace.stages.fingerprint.total_versions)],
              ]}
            />
            <TraceStage
              title="Embedding"
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
              available={trace.availability.category}
              meta={[
                ["algorithm_version", trace.stages.category.algorithm_version],
                ["winner_slug", trace.stages.category.winner_slug],
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
            />
            <TraceStage
              title="Classification chain"
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
                  {trace.stages.classification.lineage.map((node, idx) => (
                    <div key={String(node.id)} className="rounded border bg-muted/40 p-2 text-xs">
                      <p className="font-mono text-[10px] text-muted-foreground" title={String(node.id)}>
                        {String(node.id)}
                      </p>
                      <p>{String(node.category ?? "unknown")} · {String(node.severity ?? "unknown")} · {String(node.status ?? "unknown")}</p>
                      <p className="text-muted-foreground">
                        prior: {node.prior_classification_id ? <ShortId value={String(node.prior_classification_id)} /> : "none"}
                        {idx === 0 ? " (head)" : ""}
                      </p>
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
                [
                  "latest_reviewed_at",
                  <FormattedDate key="rev" iso={trace.stages.review.latest_reviewed_at} />,
                ],
                ["generated_at", <FormattedDate key="gen" iso={trace.generated_at} />],
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
