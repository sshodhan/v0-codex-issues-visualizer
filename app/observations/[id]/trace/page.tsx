"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"
import { ArrowLeft, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
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
    capture: { captured_at: string | null; published_at: string | null; source_id: string | null }
    fingerprint: { latest_computed_at: string | null; algorithm_version: string | null; total_versions: number; rows: Array<Record<string, unknown>> }
    embedding: { latest_computed_at: string | null; algorithm_version: string | null; model: string | null; dimensions: number | null; total_versions: number; rows: Array<Record<string, unknown>> }
    category: { latest_computed_at: string | null; algorithm_version: string | null; winner_slug: string | null; confidence: number | null; evidence: unknown; total_versions: number; rows: Array<Record<string, unknown>> }
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

export default function ObservationTracePage() {
  const params = useParams()
  const id = Array.isArray(params?.id) ? params.id[0] : (params?.id ?? "")

  const [trace, setTrace] = useState<ObservationTraceResponse | null>(null)
  const [events, setEvents] = useState<ProcessingEventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.all([
      fetch(`/api/observations/${id}/trace`),
      fetch(`/api/observations/${id}/classify`),
    ])
      .then(async ([traceRes, classifyRes]) => {
        if (cancelled) return
        if (!traceRes.ok) {
          if (traceRes.status === 404) {
            setError("Observation not found.")
            return
          }
          const text = await traceRes.text().catch(() => "")
          const msg = text ? `HTTP ${traceRes.status}: ${text.slice(0, 200)}` : `HTTP ${traceRes.status}`
          setError(msg)
          logClientError(new Error(msg), "reviewer-trace-fetch-non-ok", {
            observationId: id,
            status: traceRes.status,
          })
          return
        }
        const traceBody = (await traceRes.json()) as ObservationTraceResponse
        if (cancelled) return
        setTrace(traceBody)
        if (classifyRes.ok) {
          const body = (await classifyRes.json()) as { trace?: { events?: ProcessingEventItem[] } }
          if (cancelled) return
          setEvents(body.trace?.events ?? [])
        }
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : "Failed to load trace")
        logClientError(e, "reviewer-trace-fetch-failed", { observationId: id })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [id])

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
              title="Topic (regex_topic)"
              available={trace.availability.category}
              meta={[
                ["algorithm_version", trace.stages.category.algorithm_version],
                ["winner_slug", trace.stages.category.winner_slug],
                ["confidence", trace.stages.category.confidence === null ? null : trace.stages.category.confidence.toFixed(2)],
                ["latest_computed_at", trace.stages.category.latest_computed_at],
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
                      <p className="text-muted-foreground">
                        prior: {String(node.prior_classification_id ?? "none")}{idx === 0 ? " (head)" : ""}
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
          </>
        ) : null}
      </main>
    </div>
  )
}
