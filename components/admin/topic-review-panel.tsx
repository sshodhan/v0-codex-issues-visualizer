"use client"

import { useEffect, useMemo, useState } from "react"
import { Copy, Loader2, RefreshCw, Search } from "lucide-react"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { logClientError, logClientEvent } from "@/lib/error-tracking/client-logger"
import {
  TOPIC_REVIEW_REASON_CODES,
  TOPIC_REVIEW_SUGGESTED_ACTIONS,
  TOPIC_REVIEW_SUGGESTED_LAYERS,
  TOPIC_REVIEW_STATUSES,
  type GoldenSetCandidate,
} from "@/lib/admin/topic-review"

// Sentinel for Radix `Select` "no filter" entries. Radix throws a
// runtime error if a `<SelectItem value="" />` is rendered, so we round-
// trip the empty filter state through this constant: the Select sees
// `__any__`, but the URL query / filter state stays empty.
const FILTER_ANY = "__any__"

// Sentinel for "only rows that have NO review event yet" in the Queue
// filter — distinct from FILTER_ANY (which means "no status filter at
// all"). Maps to the `reviewStatus=none` API contract.
const FILTER_REVIEW_NONE = "none"

function fromFilterValue(v: string): string {
  return v === FILTER_ANY ? "" : v
}

function toFilterValue(v: string): string {
  return v === "" ? FILTER_ANY : v
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
  let body = ""
  try {
    body = (await res.text()).slice(0, 200)
  } catch {
    // ignore
  }
  return body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`
}

// Same shape used by app/admin/page.tsx + components/admin/label-backfill-runbook
// + components/admin/family-classification-panel — wraps a non-2xx response
// in an Error with .status set so the catch block can decide whether to
// log it (real bug) or suppress it (expected 401 until the operator
// provides the admin secret).
function makeAdminHttpError(status: number, message: string): Error & {
  status: number
} {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

function shouldLogAdminClientError(error: unknown): boolean {
  const status = (error as { status?: number })?.status
  // 401/403 are expected until the operator provides x-admin-secret.
  return status !== 401 && status !== 403
}

interface TraceObservation {
  observation_id: string
  title: string | null
  content: string | null
  url: string | null
  source_id: string | null
  external_id: string | null
  published_at: string | null
  captured_at: string | null
  cluster_id: string | null
  cluster_key: string | null
}

interface TraceAssignment {
  id: string
  algorithm_version: string | null
  slug: string | null
  category_id: string | null
  confidence: number | null
  evidence: unknown
  computed_at: string | null
}

interface ManualOverrideHistoryRow {
  id: string
  algorithm_version: string | null
  slug: string | null
  category_id: string | null
  confidence: number | null
  evidence: unknown
  computed_at: string | null
  is_currently_effective: boolean
}

interface TraceResponse {
  mode: string
  observation: TraceObservation
  currentAssignment: TraceAssignment | null
  latestDeterministic: TraceAssignment | null
  cluster: {
    id: string | null
    cluster_key: string | null
    label: string | null
    label_model: string | null
    label_confidence: number | null
  } | null
  clusterTopicMetadata: unknown
  manualOverrideHistory: ManualOverrideHistoryRow[]
  reviewEvents: Array<Record<string, unknown>>
  generated_at: string
}

interface QueueRow {
  observation_id: string
  title: string | null
  current_topic: string | null
  algorithm_version: string | null
  confidence_proxy: number | null
  margin: number | null
  runner_up: string | null
  cluster_id: string | null
  cluster_key: string | null
  dominant_cluster_topic: string | null
  dominant_cluster_topic_share: number | null
  latest_review_status: string | null
  computed_at: string | null
}

interface QueueResponse {
  rows: QueueRow[]
  total: number
  limit: number
  clusterMetadataAvailable: boolean
}

interface EventsRow {
  id: string
  created_at: string
  reviewer: string
  observation_id: string
  observation_title: string | null
  original_topic_slug: string | null
  corrected_topic_slug: string | null
  reason_code: string
  suggested_layer: string
  suggested_action: string
  phrase_candidate: string | null
  rationale: string | null
  status: string
}

interface EventsResponse {
  rows: EventsRow[]
  total: number
  limit: number
}

interface Category {
  id: string
  name: string
  slug: string
  color: string
}

// ============================================================================
// Trace Panel
// ============================================================================

function TopicReviewTracePanel({ secret }: { secret: string }) {
  const [observationId, setObservationId] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [traceLoading, setTraceLoading] = useState(false)
  const [traceError, setTraceError] = useState<string | null>(null)
  const [trace, setTrace] = useState<TraceResponse | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(true)

  const [reviewData, setReviewData] = useState({
    reasonCode: "",
    suggestedLayer: "",
    suggestedAction: "",
    suggestedTopicSlug: "",
    phraseCandidate: "",
    rationale: "",
    applyManualOverride: false,
  })
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewSuccess, setReviewSuccess] = useState<{
    reviewEventId: string
    manualOverrideApplied: boolean
    goldenSetCandidate: GoldenSetCandidate | null
  } | null>(null)

  // Load categories once. Silent on the UI (the override dropdown
  // simply has no options if this fails) but every failure path
  // surfaces in Vercel logs so operators can debug a missing category
  // list without staring at the panel.
  useEffect(() => {
    async function loadCategories() {
      try {
        const res = await fetch("/api/admin/topic-review/categories", {
          headers: authHeaders(secret),
        })
        if (!res.ok) {
          const message = await explainAdminFailure(res)
          const httpErr = makeAdminHttpError(res.status, message)
          if (shouldLogAdminClientError(httpErr)) {
            logClientError(httpErr, "admin-topic-review-categories-load-failed", {
              status: res.status,
            })
          }
          return
        }
        const data = (await res.json()) as { categories: Category[] }
        setCategories(data.categories)
      } catch (e) {
        if (shouldLogAdminClientError(e)) {
          logClientError(e, "admin-topic-review-categories-load-failed")
        }
      } finally {
        setCategoriesLoading(false)
      }
    }
    loadCategories()
  }, [secret])

  async function loadTrace() {
    const id = observationId.trim()
    if (!id) {
      setTraceError("Provide an observation ID")
      return
    }
    setTraceLoading(true)
    setTraceError(null)
    setTrace(null)
    setReviewSuccess(null)
    logClientEvent("admin-topic-review-trace-load-started", {
      observationId: id,
    })
    try {
      const res = await fetch(
        `/api/admin/topic-review/trace?observationId=${encodeURIComponent(id)}`,
        { headers: authHeaders(secret) },
      )
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        setTraceError(message)
        const httpErr = makeAdminHttpError(res.status, message)
        if (shouldLogAdminClientError(httpErr)) {
          logClientError(httpErr, "admin-topic-review-trace-load-failed", {
            observationId: id,
            status: res.status,
          })
        }
        return
      }
      const body = (await res.json()) as TraceResponse
      setTrace(body)
      logClientEvent("admin-topic-review-trace-load-succeeded", {
        observationId: id,
        hasCurrentAssignment: body.currentAssignment !== null,
        currentAlgorithmVersion: body.currentAssignment?.algorithm_version ?? null,
        manualOverrideHistoryCount: body.manualOverrideHistory?.length ?? 0,
        reviewEventsCount: body.reviewEvents?.length ?? 0,
      })
    } catch (e) {
      setTraceError(e instanceof Error ? e.message : "Failed to load trace")
      if (shouldLogAdminClientError(e)) {
        logClientError(e, "admin-topic-review-trace-load-failed", {
          observationId: id,
        })
      }
    } finally {
      setTraceLoading(false)
    }
  }

  async function submitReview() {
    if (!trace || !observationId.trim()) {
      setReviewError("No observation loaded")
      return
    }
    if (!reviewData.reasonCode) {
      setReviewError("reason_code is required")
      return
    }
    if (!reviewData.suggestedLayer) {
      setReviewError("suggested_layer is required")
      return
    }
    if (!reviewData.suggestedAction) {
      setReviewError("suggested_action is required")
      return
    }
    if (
      reviewData.applyManualOverride &&
      !reviewData.suggestedTopicSlug.trim()
    ) {
      setReviewError(
        "corrected topic slug is required when applying override",
      )
      return
    }

    setReviewSubmitting(true)
    setReviewError(null)
    const submissionContext = {
      observationId,
      reasonCode: reviewData.reasonCode,
      suggestedLayer: reviewData.suggestedLayer,
      suggestedAction: reviewData.suggestedAction,
      applyManualOverride: reviewData.applyManualOverride,
    }
    logClientEvent(
      "admin-topic-review-submit-started",
      submissionContext,
    )
    try {
      const res = await fetch("/api/admin/topic-review", {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({
          observationId,
          correctedCategorySlug: reviewData.applyManualOverride
            ? reviewData.suggestedTopicSlug.trim()
            : undefined,
          applyManualOverride: reviewData.applyManualOverride,
          reasonCode: reviewData.reasonCode,
          suggestedLayer: reviewData.suggestedLayer,
          suggestedAction: reviewData.suggestedAction,
          phraseCandidate: reviewData.phraseCandidate.trim() || undefined,
          rationale: reviewData.rationale.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        setReviewError(message)
        const httpErr = makeAdminHttpError(res.status, message)
        if (shouldLogAdminClientError(httpErr)) {
          logClientError(httpErr, "admin-topic-review-submit-failed", {
            ...submissionContext,
            status: res.status,
          })
        }
        return
      }
      const result = (await res.json()) as {
        ok: boolean
        reviewEventId: string
        manualOverrideApplied: boolean
        goldenSetCandidate: GoldenSetCandidate | null
      }
      setReviewSuccess({
        reviewEventId: result.reviewEventId,
        manualOverrideApplied: result.manualOverrideApplied,
        goldenSetCandidate: result.goldenSetCandidate,
      })
      logClientEvent("admin-topic-review-submit-succeeded", {
        ...submissionContext,
        reviewEventId: result.reviewEventId,
        manualOverrideApplied: result.manualOverrideApplied,
        hasGoldenSetCandidate: result.goldenSetCandidate !== null,
      })
      // Reset form
      setReviewData({
        reasonCode: "",
        suggestedLayer: "",
        suggestedAction: "",
        suggestedTopicSlug: "",
        phraseCandidate: "",
        rationale: "",
        applyManualOverride: false,
      })
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : "Submission failed")
      if (shouldLogAdminClientError(e)) {
        logClientError(e, "admin-topic-review-submit-failed", submissionContext)
      }
    } finally {
      setReviewSubmitting(false)
    }
  }

  const currentSlug = trace?.currentAssignment?.slug ?? null
  const deterministicSlug = trace?.latestDeterministic?.slug ?? null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Topic Trace &amp; Review</CardTitle>
        <CardDescription>
          Inspect a single observation's classification, review events, and
          optionally record a corrected topic assignment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search bar */}
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">
              Observation ID or title substring
            </label>
            <div className="flex gap-2">
              <Input
                value={observationId}
                onChange={(e) => setObservationId(e.target.value)}
                placeholder="UUID or title search"
                className="font-mono text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadTrace()
                }}
              />
              <Button onClick={loadTrace} disabled={traceLoading} size="sm">
                {traceLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                Load
              </Button>
            </div>
          </div>
        </div>

        {traceError && (
          <Alert variant="destructive">
            <AlertTitle>Trace load failed</AlertTitle>
            <AlertDescription>{traceError}</AlertDescription>
          </Alert>
        )}

        {trace ? (
          <div className="space-y-4">
            {/* Observation header */}
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium line-clamp-2">{trace.observation.title}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {trace.observation.observation_id}
              </p>
              {trace.observation.url && (
                <a
                  href={trace.observation.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  Open source
                </a>
              )}
            </div>

            {/* Current assignment */}
            {trace.currentAssignment ? (
              <div className="rounded-md border p-3 bg-muted/50">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">
                      Current Assignment
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="default">{currentSlug || "other"}</Badge>
                      <span className="text-xs">
                        {trace.currentAssignment.algorithm_version}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        conf {(trace.currentAssignment.confidence ?? 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
                {trace.currentAssignment.evidence && (
                  <div className="mt-2">
                    <details className="text-xs">
                      <summary className="cursor-pointer font-mono text-muted-foreground">
                        Evidence
                      </summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-[10px]">
                        {JSON.stringify(
                          trace.currentAssignment.evidence,
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-md border p-3 text-sm text-muted-foreground">
                No topic evidence available
              </div>
            )}

            {/* Manual override history. Always rendered when ANY
                manual override row exists for this observation, even
                if the most recent deterministic backfill has
                superseded it on read. Per docs/SCORING.md §11.5,
                manual rows are preserved in category_assignments
                permanently — only the MV's "pick latest" tie-breaker
                changes. Reviewers must see superseded overrides so
                they know to re-record if intent should still hold. */}
            {trace.manualOverrideHistory && trace.manualOverrideHistory.length > 0 && (
              <Alert>
                <AlertTitle className="text-sm">
                  Manual override history ({trace.manualOverrideHistory.length})
                </AlertTitle>
                <AlertDescription className="space-y-2 text-xs">
                  {trace.latestDeterministic &&
                  trace.currentAssignment?.id ===
                    trace.latestDeterministic.id ? (
                    <p className="text-amber-700 dark:text-amber-400">
                      <strong>No manual override is currently effective.</strong>{" "}
                      A deterministic Stage 1 row ({trace.latestDeterministic.algorithm_version})
                      has superseded the most recent manual override
                      because{" "}
                      <code className="font-mono">mv_observation_current</code>{" "}
                      picks{" "}
                      <code className="font-mono">max(computed_at)</code>.
                      Re-record the override if the corrected topic
                      should still apply.
                    </p>
                  ) : (
                    <p>
                      Current effective topic is a manual override
                      (deterministic {trace.latestDeterministic?.algorithm_version ?? "?"}{" "}
                      said{" "}
                      <code className="font-mono">
                        {deterministicSlug ?? "—"}
                      </code>
                      ). Note: a future Stage 1 backfill may supersede
                      this on the dashboard until the override is
                      re-recorded; the override row itself is preserved
                      permanently.
                    </p>
                  )}
                  <div className="space-y-1">
                    {trace.manualOverrideHistory.map((row) => (
                      <div
                        key={row.id}
                        className="flex items-center gap-2 rounded border bg-background/60 p-2"
                      >
                        <Badge
                          variant={
                            row.is_currently_effective ? "default" : "outline"
                          }
                          className="text-[10px]"
                        >
                          {row.is_currently_effective ? "effective" : "superseded"}
                        </Badge>
                        <code className="font-mono text-[11px]">
                          {row.slug ?? "—"}
                        </code>
                        <span className="text-[11px] text-muted-foreground">
                          {row.computed_at
                            ? new Date(row.computed_at).toISOString()
                            : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Review form */}
            {!reviewSuccess ? (
              <div className="rounded-md border p-4 space-y-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Record Review Event</p>
                  <p className="text-xs text-muted-foreground">
                    A review event is a <strong>learning signal</strong>{" "}
                    for future Stage 1 / golden-set / taxonomy edits — it
                    does <strong>not</strong> change the effective Topic
                    on read. Tick &ldquo;Apply manual topic override&rdquo;
                    below if you also want to correct the displayed
                    topic for this observation. The two actions are
                    independent: many reviewers record only the
                    structured signal.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium">reason_code</label>
                    <Select
                      value={reviewData.reasonCode}
                      onValueChange={(v) =>
                        setReviewData((prev) => ({
                          ...prev,
                          reasonCode: v,
                        }))
                      }
                    >
                      <SelectTrigger className="text-xs h-8">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {TOPIC_REVIEW_REASON_CODES.map((rc) => (
                          <SelectItem key={rc} value={rc} className="text-xs">
                            {rc}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium">suggested_layer</label>
                    <Select
                      value={reviewData.suggestedLayer}
                      onValueChange={(v) =>
                        setReviewData((prev) => ({
                          ...prev,
                          suggestedLayer: v,
                        }))
                      }
                    >
                      <SelectTrigger className="text-xs h-8">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {TOPIC_REVIEW_SUGGESTED_LAYERS.map((sl) => (
                          <SelectItem
                            key={sl}
                            value={sl}
                            className="text-xs"
                          >
                            {sl}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1 col-span-2">
                    <label className="text-xs font-medium">suggested_action</label>
                    <Select
                      value={reviewData.suggestedAction}
                      onValueChange={(v) =>
                        setReviewData((prev) => ({
                          ...prev,
                          suggestedAction: v,
                        }))
                      }
                    >
                      <SelectTrigger className="text-xs h-8">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {TOPIC_REVIEW_SUGGESTED_ACTIONS.map((sa) => (
                          <SelectItem
                            key={sa}
                            value={sa}
                            className="text-xs"
                          >
                            {sa}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1 col-span-2">
                    <label className="text-xs font-medium">
                      phrase_candidate (optional)
                    </label>
                    <Input
                      value={reviewData.phraseCandidate}
                      onChange={(e) =>
                        setReviewData((prev) => ({
                          ...prev,
                          phraseCandidate: e.target.value,
                        }))
                      }
                      placeholder="e.g., 'lost work' for feature-request"
                      className="text-xs h-8"
                    />
                  </div>

                  <div className="space-y-1 col-span-2">
                    <label className="text-xs font-medium">
                      rationale (optional)
                    </label>
                    <Textarea
                      value={reviewData.rationale}
                      onChange={(e) =>
                        setReviewData((prev) => ({
                          ...prev,
                          rationale: e.target.value,
                        }))
                      }
                      placeholder="Why this classification?"
                      className="text-xs min-h-16"
                    />
                  </div>

                  <div className="space-y-1 col-span-2 rounded-md border-t pt-3 mt-1">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="apply-override"
                        checked={reviewData.applyManualOverride}
                        onCheckedChange={(checked) =>
                          setReviewData((prev) => ({
                            ...prev,
                            applyManualOverride: checked === true,
                          }))
                        }
                      />
                      <div className="space-y-1">
                        <label
                          htmlFor="apply-override"
                          className="text-xs font-medium cursor-pointer block"
                        >
                          Also apply a manual topic override (read-time
                          correction)
                        </label>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Optional. Appends an{" "}
                          <code className="rounded bg-muted px-1 py-0.5">
                            algorithm_version=&apos;manual&apos;
                          </code>{" "}
                          row to{" "}
                          <code className="rounded bg-muted px-1 py-0.5">
                            category_assignments
                          </code>
                          . Wins on read until the next Stage 1
                          backfill; the original deterministic verdict
                          is preserved.
                        </p>
                      </div>
                    </div>
                  </div>

                  {reviewData.applyManualOverride && (
                    <div className="space-y-1 col-span-2">
                      <label className="text-xs font-medium">
                        Corrected topic slug
                      </label>
                      <Select
                        value={reviewData.suggestedTopicSlug}
                        onValueChange={(v) =>
                          setReviewData((prev) => ({
                            ...prev,
                            suggestedTopicSlug: v,
                          }))
                        }
                      >
                        <SelectTrigger className="text-xs h-8">
                          <SelectValue placeholder="Select topic..." />
                        </SelectTrigger>
                        <SelectContent>
                          {categories.map((cat) => (
                            <SelectItem
                              key={cat.id}
                              value={cat.slug}
                              className="text-xs"
                            >
                              {cat.name} ({cat.slug})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {reviewError && (
                  <Alert variant="destructive">
                    <AlertTitle className="text-xs">Submission error</AlertTitle>
                    <AlertDescription className="text-xs">
                      {reviewError}
                    </AlertDescription>
                  </Alert>
                )}

                <Button
                  onClick={submitReview}
                  disabled={reviewSubmitting}
                  size="sm"
                  className="w-full"
                >
                  {reviewSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Submit Review
                </Button>
              </div>
            ) : (
              <Alert>
                <AlertTitle>
                  {reviewSuccess.manualOverrideApplied
                    ? "Review event recorded + manual override applied"
                    : "Review event recorded"}
                </AlertTitle>
                <AlertDescription className="space-y-2 text-xs">
                  <p>Event ID: {reviewSuccess.reviewEventId}</p>
                  {reviewSuccess.manualOverrideApplied && (
                    // Persistent visibility for the path-B precedence
                    // contract per docs/SCORING.md §11.5. Manual
                    // overrides are read-time corrections, NOT
                    // permanent: a future Stage-1 backfill (e.g.
                    // category v6 → v7) writes a fresher deterministic
                    // row that supersedes the override on
                    // mv_observation_current. The override row itself
                    // is preserved permanently in category_assignments
                    // and remains visible in the trace history; only
                    // the dashboard's effective-on-read pick changes.
                    <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                      <p className="font-medium">Read-time correction, not permanent</p>
                      <p className="mt-1">
                        This override wins on the dashboard <em>now</em>{" "}
                        because it is the freshest{" "}
                        <code className="font-mono">category_assignments</code>{" "}
                        row. A future Stage 1 backfill (e.g. a category{" "}
                        v6 → v7 algorithm bump) will write a newer
                        deterministic row that supersedes this override
                        on read. The override row itself is preserved
                        in <code className="font-mono">category_assignments</code>{" "}
                        permanently and stays visible in the trace
                        history above. To re-pin the corrected topic
                        after a backfill, re-record the override
                        (one click; appends another manual row that
                        becomes the freshest). See docs/SCORING.md
                        §11.5.
                      </p>
                    </div>
                  )}
                  {reviewSuccess.goldenSetCandidate && (
                    <div className="mt-2">
                      <p className="text-[11px] text-muted-foreground mb-1">
                        Golden-set candidate (copyable JSONL — not
                        auto-written to the fixture):
                      </p>
                      <p className="font-mono text-[10px] bg-muted p-2 rounded overflow-x-auto">
                        {JSON.stringify(reviewSuccess.goldenSetCandidate)}
                      </p>
                    </div>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Queue Panel
// ============================================================================

function TopicReviewQueuePanel({ secret }: { secret: string }) {
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueResponse | null>(null)
  const [filters, setFilters] = useState({
    topic: "",
    marginMax: "",
    confidenceMax: "",
    algorithmVersion: "v6",
    clusterId: "",
    dominantTopicSlug: "",
    reviewStatus: "",
  })

  async function loadQueue() {
    setQueueLoading(true)
    setQueueError(null)
    const filterContext = {
      topic: filters.topic || null,
      marginMax: filters.marginMax || null,
      confidenceMax: filters.confidenceMax || null,
      algorithmVersion: filters.algorithmVersion || null,
      clusterId: filters.clusterId || null,
      dominantTopicSlug: filters.dominantTopicSlug || null,
      reviewStatus: filters.reviewStatus || null,
    }
    logClientEvent("admin-topic-review-queue-load-started", filterContext)
    try {
      const params = new URLSearchParams()
      if (filters.topic) params.set("topic", filters.topic)
      if (filters.marginMax) params.set("marginMax", filters.marginMax)
      if (filters.confidenceMax)
        params.set("confidenceMax", filters.confidenceMax)
      if (filters.algorithmVersion)
        params.set("algorithmVersion", filters.algorithmVersion)
      if (filters.clusterId) params.set("clusterId", filters.clusterId)
      if (filters.dominantTopicSlug)
        params.set("dominantTopicSlug", filters.dominantTopicSlug)
      if (filters.reviewStatus) params.set("reviewStatus", filters.reviewStatus)

      const res = await fetch(`/api/admin/topic-review/queue?${params}`, {
        headers: authHeaders(secret),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        setQueueError(message)
        const httpErr = makeAdminHttpError(res.status, message)
        if (shouldLogAdminClientError(httpErr)) {
          logClientError(httpErr, "admin-topic-review-queue-load-failed", {
            ...filterContext,
            status: res.status,
          })
        }
        return
      }
      const body = (await res.json()) as QueueResponse
      setQueue(body)
      logClientEvent("admin-topic-review-queue-load-succeeded", {
        ...filterContext,
        rows: body.rows.length,
        clusterMetadataAvailable: body.clusterMetadataAvailable,
      })
    } catch (e) {
      setQueueError(e instanceof Error ? e.message : "Queue load failed")
      if (shouldLogAdminClientError(e)) {
        logClientError(e, "admin-topic-review-queue-load-failed", filterContext)
      }
    } finally {
      setQueueLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review Queue</CardTitle>
        <CardDescription>
          Sampled from recent deterministic{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">category_assignments</code>{" "}
          rows (not an exhaustive audit export) — broaden filters or
          raise the limit if expected candidates are missing. Filter by
          topic, margin, confidence, or review status.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">Topic</label>
            <Input
              value={filters.topic}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, topic: e.target.value }))
              }
              placeholder="e.g., other"
              className="text-xs h-8"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Margin ≤</label>
            <Input
              value={filters.marginMax}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, marginMax: e.target.value }))
              }
              placeholder="e.g., 2"
              type="number"
              className="text-xs h-8"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Confidence ≤</label>
            <Input
              value={filters.confidenceMax}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  confidenceMax: e.target.value,
                }))
              }
              placeholder="e.g., 0.25"
              type="number"
              step="0.01"
              className="text-xs h-8"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Algorithm</label>
            <Input
              value={filters.algorithmVersion}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  algorithmVersion: e.target.value,
                }))
              }
              placeholder="v6"
              className="text-xs h-8"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Cluster ID</label>
            <Input
              value={filters.clusterId}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  clusterId: e.target.value,
                }))
              }
              placeholder="UUID"
              className="text-xs h-8"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Review Status</label>
            <Select
              value={toFilterValue(filters.reviewStatus)}
              onValueChange={(v) =>
                setFilters((prev) => ({
                  ...prev,
                  reviewStatus: fromFilterValue(v),
                }))
              }
            >
              <SelectTrigger className="text-xs h-8">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ANY}>Any</SelectItem>
                <SelectItem value={FILTER_REVIEW_NONE}>None</SelectItem>
                {TOPIC_REVIEW_STATUSES.map((st) => (
                  <SelectItem key={st} value={st} className="text-xs">
                    {st}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button onClick={loadQueue} disabled={queueLoading} size="sm">
          {queueLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Load Queue
        </Button>

        {queueError && (
          <Alert variant="destructive">
            <AlertTitle>Queue load failed</AlertTitle>
            <AlertDescription>{queueError}</AlertDescription>
          </Alert>
        )}

        {queue && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {queue.total} observations
                {!queue.clusterMetadataAvailable &&
                  filters.dominantTopicSlug && (
                    <span className="text-xs ml-2">
                      (cluster metadata unavailable in this environment)
                    </span>
                  )}
              </p>
            </div>
            {queue.rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No results.</p>
            ) : (
              <div className="overflow-x-auto border rounded-md">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Title</TableHead>
                      <TableHead className="text-xs">Current</TableHead>
                      <TableHead className="text-xs">Conf</TableHead>
                      <TableHead className="text-xs">Margin</TableHead>
                      <TableHead className="text-xs">Runner-up</TableHead>
                      <TableHead className="text-xs">Review</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.rows.map((row) => (
                      <TableRow key={row.observation_id}>
                        <TableCell className="font-mono text-[11px] max-w-xs truncate">
                          {row.title || row.observation_id}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {row.current_topic || "other"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {row.confidence_proxy
                            ? row.confidence_proxy.toFixed(2)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.margin ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.runner_up || "—"}
                        </TableCell>
                        <TableCell>
                          {row.latest_review_status ? (
                            <Badge variant="secondary" className="text-xs">
                              {row.latest_review_status}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Events Panel
// ============================================================================

function TopicReviewEventsPanel({ secret }: { secret: string }) {
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [events, setEvents] = useState<EventsResponse | null>(null)
  const [filters, setFilters] = useState({
    status: "",
    suggestedLayer: "",
    suggestedAction: "",
    reasonCode: "",
  })

  async function loadEvents() {
    setEventsLoading(true)
    setEventsError(null)
    const filterContext = {
      status: filters.status || null,
      suggestedLayer: filters.suggestedLayer || null,
      suggestedAction: filters.suggestedAction || null,
      reasonCode: filters.reasonCode || null,
    }
    logClientEvent("admin-topic-review-events-load-started", filterContext)
    try {
      const params = new URLSearchParams()
      if (filters.status) params.set("status", filters.status)
      if (filters.suggestedLayer)
        params.set("suggestedLayer", filters.suggestedLayer)
      if (filters.suggestedAction)
        params.set("suggestedAction", filters.suggestedAction)
      if (filters.reasonCode) params.set("reasonCode", filters.reasonCode)

      const res = await fetch(`/api/admin/topic-review/events?${params}`, {
        headers: authHeaders(secret),
      })
      if (!res.ok) {
        const message = await explainAdminFailure(res)
        setEventsError(message)
        const httpErr = makeAdminHttpError(res.status, message)
        if (shouldLogAdminClientError(httpErr)) {
          logClientError(httpErr, "admin-topic-review-events-load-failed", {
            ...filterContext,
            status: res.status,
          })
        }
        return
      }
      const body = (await res.json()) as EventsResponse
      setEvents(body)
      logClientEvent("admin-topic-review-events-load-succeeded", {
        ...filterContext,
        rows: body.rows.length,
      })
    } catch (e) {
      setEventsError(e instanceof Error ? e.message : "Events load failed")
      if (shouldLogAdminClientError(e)) {
        logClientError(e, "admin-topic-review-events-load-failed", filterContext)
      }
    } finally {
      setEventsLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review Events</CardTitle>
        <CardDescription>
          Browse all recorded topic review events. Filter by status, layer,
          action, or reason.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">Status</label>
            <Select
              value={toFilterValue(filters.status)}
              onValueChange={(v) =>
                setFilters((prev) => ({ ...prev, status: fromFilterValue(v) }))
              }
            >
              <SelectTrigger className="text-xs h-8">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ANY}>Any</SelectItem>
                {TOPIC_REVIEW_STATUSES.map((st) => (
                  <SelectItem key={st} value={st} className="text-xs">
                    {st}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Layer</label>
            <Select
              value={toFilterValue(filters.suggestedLayer)}
              onValueChange={(v) =>
                setFilters((prev) => ({
                  ...prev,
                  suggestedLayer: fromFilterValue(v),
                }))
              }
            >
              <SelectTrigger className="text-xs h-8">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ANY}>Any</SelectItem>
                {TOPIC_REVIEW_SUGGESTED_LAYERS.map((sl) => (
                  <SelectItem key={sl} value={sl} className="text-xs">
                    {sl}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Action</label>
            <Select
              value={toFilterValue(filters.suggestedAction)}
              onValueChange={(v) =>
                setFilters((prev) => ({
                  ...prev,
                  suggestedAction: fromFilterValue(v),
                }))
              }
            >
              <SelectTrigger className="text-xs h-8">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ANY}>Any</SelectItem>
                {TOPIC_REVIEW_SUGGESTED_ACTIONS.map((sa) => (
                  <SelectItem key={sa} value={sa} className="text-xs">
                    {sa}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Reason</label>
            <Select
              value={toFilterValue(filters.reasonCode)}
              onValueChange={(v) =>
                setFilters((prev) => ({
                  ...prev,
                  reasonCode: fromFilterValue(v),
                }))
              }
            >
              <SelectTrigger className="text-xs h-8">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ANY}>Any</SelectItem>
                {TOPIC_REVIEW_REASON_CODES.map((rc) => (
                  <SelectItem key={rc} value={rc} className="text-xs">
                    {rc}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button onClick={loadEvents} disabled={eventsLoading} size="sm">
          {eventsLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Load Events
        </Button>

        {eventsError && (
          <Alert variant="destructive">
            <AlertTitle>Events load failed</AlertTitle>
            <AlertDescription>{eventsError}</AlertDescription>
          </Alert>
        )}

        {events && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{events.total} events</p>
            {events.rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No events.</p>
            ) : (
              <div className="overflow-x-auto border rounded-md">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Created</TableHead>
                      <TableHead className="text-xs">Observation</TableHead>
                      <TableHead className="text-xs">Original</TableHead>
                      <TableHead className="text-xs">Corrected</TableHead>
                      <TableHead className="text-xs">Reason</TableHead>
                      <TableHead className="text-xs">Action</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-[11px] whitespace-nowrap">
                          {new Date(row.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] max-w-xs truncate">
                          {row.observation_title || row.observation_id}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {row.original_topic_slug || "—"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {row.corrected_topic_slug ? (
                            <Badge className="text-xs">
                              {row.corrected_topic_slug}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-[11px]">
                          {row.reason_code}
                        </TableCell>
                        <TableCell className="text-[11px]">
                          {row.suggested_action}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs">
                            {row.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Main export
// ============================================================================

export function TopicReviewPanel({ secret }: { secret: string }) {
  return (
    <Tabs defaultValue="trace" className="space-y-4">
      <TabsList>
        <TabsTrigger value="trace">Trace</TabsTrigger>
        <TabsTrigger value="queue">Queue</TabsTrigger>
        <TabsTrigger value="events">Events</TabsTrigger>
      </TabsList>
      <TabsContent value="trace">
        <TopicReviewTracePanel secret={secret} />
      </TabsContent>
      <TabsContent value="queue">
        <TopicReviewQueuePanel secret={secret} />
      </TabsContent>
      <TabsContent value="events">
        <TopicReviewEventsPanel secret={secret} />
      </TabsContent>
    </Tabs>
  )
}
