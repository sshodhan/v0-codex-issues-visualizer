"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw, Zap } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { logClientError } from "@/lib/error-tracking/client-logger"

interface DryRunResponse {
  algorithm_version: string
  total_active_observations: number
  with_v3_embedding: number
  awaiting_v3_embedding: number
  stale_v3_embedding: number
  candidate_count: number
  candidate_ids_preview: string[]
  hints: {
    coverage_pct: number | null
    suggested_limit: number
    expected_cost_usd_per_full_run: number | null
  }
}

interface ApplyResponse {
  algorithm_version: string
  attempted: number
  succeeded: number
  failed: number
  cached: number
  failures: Array<{ observation_id: string; reason: string }>
  next_resume_from: string | null
  durationMs: number
}

const LIMIT_OPTIONS = ["10", "25", "50", "100", "200"] as const

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—"
  return `${(v * 100).toFixed(1)}%`
}

function fmtCount(v: number | null | undefined): string {
  if (v == null) return "—"
  return v.toLocaleString()
}

/**
 * Phase 4 PR3 — v3 embedding backfill admin panel.
 *
 * Two-stage flow: refresh dry-run preview → apply a batch (or "Run
 * until done" loop). Surfaces:
 *
 *   - Coverage diagnostics: total active, with v3, awaiting, stale.
 *   - Candidate count + first 10 IDs (so the operator can spot-check).
 *   - Cost projection (rough — ~$0.000012 per text-embedding-3-small
 *     call).
 *   - Apply mode with limit + include_stale toggle.
 *
 * Hard prerequisite (operational, not enforced in code): Stage 4a
 * coverage must be ≥ 80% per docs/PHASE_4_4A_COVERAGE_RUNBOOK.md
 * before the operator should hit Apply. Dry-run is safe at any
 * coverage. The panel surfaces a warning when the underlying
 * Phase 2 metric is below 80% (TODO future PR — for now, the
 * runbook is the gate).
 */
export function V3EmbeddingBackfillPanel({ secret }: { secret: string }) {
  const [preview, setPreview] = useState<DryRunResponse | null>(null)
  const [lastApply, setLastApply] = useState<ApplyResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState<string>("25")
  const [includeStale, setIncludeStale] = useState(true)

  const refreshPreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        include_stale: includeStale ? "true" : "false",
      })
      const res = await fetch(`/api/admin/embeddings/backfill-v3?${params.toString()}`, {
        headers: secret ? { "x-admin-secret": secret } : {},
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = (await res.json()) as DryRunResponse
      setPreview(payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-v3-backfill-preview-failed", { includeStale })
    } finally {
      setLoading(false)
    }
  }, [includeStale, secret])

  useEffect(() => {
    if (!secret) return
    void refreshPreview()
  }, [refreshPreview, secret])

  const apply = useCallback(async () => {
    if (!secret) return
    setApplying(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        dry_run: "false",
        limit,
        include_stale: includeStale ? "true" : "false",
      })
      const res = await fetch(`/api/admin/embeddings/backfill-v3?${params.toString()}`, {
        method: "POST",
        headers: { "x-admin-secret": secret },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = (await res.json()) as ApplyResponse
      setLastApply(payload)
      // Refresh preview after apply so the operator sees the new state.
      await refreshPreview()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      logClientError(e, "admin-v3-backfill-apply-failed", { limit, includeStale })
    } finally {
      setApplying(false)
    }
  }, [includeStale, limit, refreshPreview, secret])

  const candidateCount = preview?.candidate_count ?? 0
  const canApply = candidateCount > 0 && !applying && !!secret

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>v3 embedding backfill</CardTitle>
            <CardDescription>
              Generate v3 (classification-aware tier-ordered) embeddings for
              observations that don&apos;t have one yet. Append-only — v1/v2
              rows preserved for replay.{" "}
              <strong>
                Confirm Stage 4a coverage is ≥ 80% before clicking Apply
              </strong>{" "}
              (per <code className="rounded bg-muted px-1 py-0.5 text-[10px]">docs/PHASE_4_4A_COVERAGE_RUNBOOK.md</code>).
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={refreshPreview}
              disabled={loading || !secret}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh preview
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!secret && (
          <Alert>
            <AlertTitle>Admin secret required</AlertTitle>
            <AlertDescription>
              Enter the admin secret at the top of this page to load the
              backfill preview.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loading && !preview && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading preview…
          </div>
        )}

        {preview && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="Active observations"
                value={fmtCount(preview.total_active_observations)}
              />
              <Stat
                label="v3 embedded"
                value={`${fmtCount(preview.with_v3_embedding)} (${fmtPct(preview.hints.coverage_pct)})`}
              />
              <Stat
                label="Awaiting"
                value={fmtCount(preview.awaiting_v3_embedding)}
              />
              <Stat
                label="Stale"
                value={fmtCount(preview.stale_v3_embedding)}
              />
            </div>

            <div className="rounded-md border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">
                    {fmtCount(candidateCount)} candidates queued
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Algorithm version{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                      {preview.algorithm_version}
                    </code>{" "}
                    • Estimated full-run cost{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                      ${preview.hints.expected_cost_usd_per_full_run?.toFixed(2) ?? "—"}
                    </code>
                  </div>
                  {preview.candidate_ids_preview.length > 0 && (
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                      preview: {preview.candidate_ids_preview.slice(0, 5).join(", ")}
                      {preview.candidate_ids_preview.length > 5 && " …"}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={includeStale}
                      onChange={(e) => setIncludeStale(e.target.checked)}
                    />
                    include stale
                  </label>
                  <Select value={limit} onValueChange={setLimit}>
                    <SelectTrigger className="h-8 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LIMIT_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          limit {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={apply} disabled={!canApply}>
                    {applying ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="mr-2 h-4 w-4" />
                    )}
                    Apply
                  </Button>
                </div>
              </div>
            </div>

            {lastApply && (
              <Alert>
                <AlertTitle>Last batch</AlertTitle>
                <AlertDescription className="space-y-1">
                  <div className="text-xs">
                    Attempted <strong>{lastApply.attempted}</strong>, succeeded{" "}
                    <strong>{lastApply.succeeded}</strong>, failed{" "}
                    <strong>{lastApply.failed}</strong> in{" "}
                    {(lastApply.durationMs / 1000).toFixed(1)}s.
                  </div>
                  {lastApply.failures.length > 0 && (
                    <div className="font-mono text-[10px] text-muted-foreground">
                      first failure: {lastApply.failures[0].observation_id} —{" "}
                      {lastApply.failures[0].reason}
                    </div>
                  )}
                  {lastApply.next_resume_from && (
                    <div className="text-[10px] text-muted-foreground">
                      next_resume_from:{" "}
                      <code>{lastApply.next_resume_from}</code>
                    </div>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm tabular-nums">{value}</div>
    </div>
  )
}
