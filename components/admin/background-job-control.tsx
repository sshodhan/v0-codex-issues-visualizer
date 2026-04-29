"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Loader2, Play, Square, AlertTriangle, CheckCircle2 } from "lucide-react"
import { logClientError } from "@/lib/error-tracking/client-logger"

// Compact controller for the async classification_jobs queue. Single
// component used by both the observation panel (kind='observation') and
// the cluster panel (kind='cluster'); the only thing they parameterize
// differently is the request body the operator wants to enqueue.
//
// Behavior:
//   - "Run as background batch" button POSTs /api/admin/classification-jobs
//     with the resolved params; receives a job back; persists job_id in
//     localStorage keyed by `kind` so the strip survives a tab reload
//     mid-job.
//   - Once a job is active, the component polls GET /:id every 4s and
//     opportunistically POSTs /:id/advance every 8s. The advance call is
//     what actually moves the job forward on Hobby plans where the
//     vercel cron can't tick minutely; on Pro the cron does the same
//     thing in parallel and the heartbeat fence keeps them from racing.
//   - Cancel button POSTs /:id/cancel; the worker honors it within ≤1
//     batch (cluster mode) or the next batch boundary (observation
//     mode). Render the cancelled state so the operator sees feedback
//     immediately.
//   - On completion the optional onCompleted callback fires so the
//     parent can refresh its stats / pending lists.

const POLL_INTERVAL_MS = 4_000
const ADVANCE_INTERVAL_MS = 8_000

type JobKind = "observation" | "cluster"
type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

interface JobShape {
  id: string
  kind: JobKind
  status: JobStatus
  total_target: number | null
  processed: number
  classified: number
  failed: number
  last_error: string | null
  finished_at: string | null
  created_at: string
}

export interface EnqueueParams {
  kind: JobKind
  limit: number
  minImpactScore?: number
  clusterIds?: string[]
}

interface BackgroundJobControlProps {
  secret: string
  kind: JobKind
  /** Called when the operator clicks "Run as background batch". The
   *  parent reads its live form state and returns the enqueue body. Can
   *  return null to abort (e.g. when the form is invalid). */
  buildEnqueueParams: () => EnqueueParams | null
  /** Fires when a job transitions to completed/failed/cancelled so the
   *  parent can refresh stats, pending lists, etc. */
  onCompleted?: (job: JobShape) => void
  /** Optional override of the button copy. Defaults to "Run as background batch". */
  buttonLabel?: string
  /** Disabled while sync work is in flight. */
  disabled?: boolean
}

function authHeaders(secret: string): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" }
  if (secret) h["x-admin-secret"] = secret
  return h
}

function storageKey(kind: JobKind): string {
  return `classification-job:${kind}`
}

function statusBadgeVariant(
  status: JobStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "running" || status === "queued") return "secondary"
  if (status === "completed") return "default"
  if (status === "failed") return "destructive"
  return "outline"
}

function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

export function BackgroundJobControl({
  secret,
  kind,
  buildEnqueueParams,
  onCompleted,
  buttonLabel,
  disabled,
}: BackgroundJobControlProps) {
  const [job, setJob] = useState<JobShape | null>(null)
  const [enqueuing, setEnqueuing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  // onCompleted should fire exactly once per job. We track the id of
  // the job we've already notified for to avoid retriggering on every
  // poll once the job hits a terminal state.
  const completedNotifiedFor = useRef<string | null>(null)

  // Resume across reloads. localStorage holds the active job_id keyed
  // by kind; a hard reload mid-job picks up the same row instead of
  // appearing to have lost the work.
  useEffect(() => {
    if (typeof window === "undefined") return
    const stored = window.localStorage.getItem(storageKey(kind))
    if (!stored) return
    // Best-effort hydrate; if the stored id is invalid (server returned
    // 404) we just clear it and the strip stays hidden.
    void fetchJob(stored)
      .then((row) => {
        if (!row) {
          window.localStorage.removeItem(storageKey(kind))
          return
        }
        setJob(row)
      })
      .catch(() => {
        window.localStorage.removeItem(storageKey(kind))
      })
    // We intentionally only run this on mount; the secret could change
    // later but the active-job hydration shouldn't re-run on every
    // re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchJob = useCallback(
    async (id: string): Promise<JobShape | null> => {
      const res = await fetch(`/api/admin/classification-jobs/${id}`, {
        headers: authHeaders(secret),
      })
      if (res.status === 404) return null
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const body = (await res.json()) as { job: JobShape }
      return body.job
    },
    [secret],
  )

  const advanceJob = useCallback(
    async (id: string): Promise<JobShape | null> => {
      const res = await fetch(`/api/admin/classification-jobs/${id}/advance`, {
        method: "POST",
        headers: authHeaders(secret),
      })
      if (!res.ok) {
        // Don't throw — advance failures are recoverable; the next
        // poll will re-read the row. Surface the message in `error`.
        let message = `HTTP ${res.status}`
        try {
          const body = (await res.json()) as { error?: string }
          if (body.error) message = body.error
        } catch {
          // ignore
        }
        setError(message)
        return null
      }
      const body = (await res.json()) as { job: JobShape }
      setError(null)
      return body.job
    },
    [secret],
  )

  // Poll + advance loop. Two separate intervals so a slow advance
  // doesn't throttle the read-only poll. Both clear when the job hits a
  // terminal state.
  useEffect(() => {
    if (!job || isTerminal(job.status)) return
    const id = job.id

    let cancelled = false
    const pollHandle = window.setInterval(() => {
      if (cancelled) return
      void fetchJob(id)
        .then((row) => {
          if (cancelled || !row) return
          setJob(row)
        })
        .catch((e) => {
          if (cancelled) return
          logClientError(e, "background-job-poll-failed")
        })
    }, POLL_INTERVAL_MS)

    const advanceHandle = window.setInterval(() => {
      if (cancelled) return
      void advanceJob(id)
        .then((row) => {
          if (cancelled || !row) return
          setJob(row)
        })
        .catch((e) => {
          if (cancelled) return
          logClientError(e, "background-job-advance-failed")
        })
    }, ADVANCE_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(pollHandle)
      window.clearInterval(advanceHandle)
    }
  }, [job, fetchJob, advanceJob])

  // Fire onCompleted once per job when it terminates, and clear the
  // localStorage anchor so a reload doesn't re-show a stale strip.
  useEffect(() => {
    if (!job) return
    if (!isTerminal(job.status)) return
    if (completedNotifiedFor.current === job.id) return
    completedNotifiedFor.current = job.id
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(storageKey(job.kind))
      if (stored === job.id) {
        window.localStorage.removeItem(storageKey(job.kind))
      }
    }
    if (onCompleted) onCompleted(job)
  }, [job, onCompleted])

  const onEnqueue = async () => {
    if (enqueuing) return
    setError(null)
    const params = buildEnqueueParams()
    if (!params) return

    setEnqueuing(true)
    try {
      const res = await fetch("/api/admin/classification-jobs", {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        let message = `HTTP ${res.status}`
        try {
          const body = (await res.json()) as { error?: string }
          if (body.error) message = body.error
        } catch {
          // ignore
        }
        throw new Error(message)
      }
      const body = (await res.json()) as { job: JobShape }
      completedNotifiedFor.current = null
      setJob(body.job)
      if (typeof window !== "undefined") {
        window.localStorage.setItem(storageKey(kind), body.job.id)
      }
      // Kick the worker once immediately so the operator doesn't wait a
      // full poll interval to see the first batch's progress.
      void advanceJob(body.job.id)
        .then((row) => {
          if (row) setJob(row)
        })
        .catch(() => {
          // already logged inside advanceJob
        })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      logClientError(e, "background-job-enqueue-failed")
    } finally {
      setEnqueuing(false)
    }
  }

  const onCancel = async () => {
    if (!job || cancelling) return
    setCancelling(true)
    try {
      const res = await fetch(
        `/api/admin/classification-jobs/${job.id}/cancel`,
        {
          method: "POST",
          headers: authHeaders(secret),
        },
      )
      if (!res.ok) {
        let message = `HTTP ${res.status}`
        try {
          const body = (await res.json()) as { error?: string }
          if (body.error) message = body.error
        } catch {
          // ignore
        }
        throw new Error(message)
      }
      const body = (await res.json()) as { job: JobShape }
      setJob(body.job)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      logClientError(e, "background-job-cancel-failed")
    } finally {
      setCancelling(false)
    }
  }

  const onDismiss = () => {
    setJob(null)
    completedNotifiedFor.current = null
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(storageKey(kind))
    }
  }

  const showStrip = job !== null
  const active = job && !isTerminal(job.status)
  const total = job?.total_target ?? null
  // Show progress only when total is known. Otherwise we surface raw
  // counts so the operator still sees forward motion.
  const progressPct =
    total != null && total > 0
      ? Math.min(100, Math.round((job!.processed / total) * 100))
      : null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onEnqueue}
          disabled={disabled || enqueuing || !!active}
        >
          {enqueuing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          {buttonLabel ?? "Run as background batch"}
        </Button>
        {active && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={cancelling}
          >
            {cancelling ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Square className="mr-2 h-4 w-4" />
            )}
            Cancel job
          </Button>
        )}
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <span>{error}</span>
        </div>
      )}
      {showStrip && job && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={statusBadgeVariant(job.status)}>{job.status}</Badge>
              <span className="font-mono text-xs text-muted-foreground">
                {job.id.slice(0, 8)}…
              </span>
              {job.status === "completed" && (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              )}
            </div>
            {isTerminal(job.status) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onDismiss}
                className="h-7 px-2 text-xs"
              >
                Dismiss
              </Button>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              processed <span className="font-mono">{job.processed}</span>
              {total != null && (
                <> / <span className="font-mono">{total}</span></>
              )}
            </span>
            <span>
              classified <span className="font-mono">{job.classified}</span>
            </span>
            <span>
              failed <span className="font-mono">{job.failed}</span>
            </span>
          </div>
          {progressPct != null && (
            <Progress value={progressPct} className="mt-2 h-1.5" />
          )}
          {job.last_error && (
            <div className="mt-1 truncate text-xs text-destructive">
              {job.last_error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
