import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  enqueueJob,
  listJobs,
  type ClassificationJobKind,
  type ClassificationJobParams,
  type ObservationJobParams,
  type ClusterJobParams,
} from "@/lib/admin/classification-jobs"
import { clampMinImpact } from "@/lib/classification/run-backfill-constants"
import { logServerError } from "@/lib/error-tracking/server-logger"

// Admin endpoint for the async classification job queue.
//
//   POST /api/admin/classification-jobs
//     Enqueue a new job. Body shape (discriminated by `kind`):
//       { kind: "observation", limit, minImpactScore? }
//       { kind: "cluster",     limit, clusterIds? }
//     Returns 202 Accepted with the new job row. The first batch is
//     NOT processed inline — the cron tick (or the operator's polling
//     /:id/advance call) will pick it up.
//
//   GET /api/admin/classification-jobs?activeOnly=1&kind=observation
//     List jobs, newest first. Used by the panel's active-job badge
//     and history strip.
//
// See lib/admin/classification-jobs.ts for the data model and
// scripts/033_classification_jobs.sql for the table.

export const maxDuration = 60

const ALLOWED_KINDS = new Set<ClassificationJobKind>(["observation", "cluster"])
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 50

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const url = new URL(request.url)
  const activeOnly = url.searchParams.get("activeOnly") === "1"
  const kindParam = url.searchParams.get("kind") as ClassificationJobKind | null
  const limitParam = Number(url.searchParams.get("limit") ?? 25)
  const limit = Math.max(1, Math.min(Number.isFinite(limitParam) ? limitParam : 25, 100))

  try {
    const supabase = createAdminClient()
    const jobs = await listJobs(supabase, {
      activeOnly,
      kind: kindParam && ALLOWED_KINDS.has(kindParam) ? kindParam : undefined,
      limit,
    })
    return NextResponse.json({ jobs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("admin-classification-jobs", "list_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  let body: {
    kind?: ClassificationJobKind
    limit?: number
    minImpactScore?: number
    clusterIds?: string[]
  } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    )
  }

  if (!body.kind || !ALLOWED_KINDS.has(body.kind)) {
    return NextResponse.json(
      { error: "kind must be 'observation' or 'cluster'" },
      { status: 400 },
    )
  }

  const limitRaw = Number(body.limit ?? DEFAULT_LIMIT)
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, MAX_LIMIT),
  )

  let params: ClassificationJobParams
  let totalTarget: number | null = null

  if (body.kind === "observation") {
    // clampMinImpact also rounds to 1 decimal so "4.84" → 4.8 (matches
    // the dashboard's score precision).
    const obs: ObservationJobParams = {
      limit,
      minImpactScore: body.minImpactScore !== undefined
        ? clampMinImpact(body.minImpactScore)
        : undefined,
    }
    params = obs
    // Don't pre-compute total_target for observations; the worker will
    // figure it out lazily on the first batch (the candidate count
    // depends on the same threshold + window the operator picked).
  } else {
    // cluster
    const ids = Array.isArray(body.clusterIds)
      ? body.clusterIds.filter((s): s is string => typeof s === "string" && s.length > 0)
      : undefined
    const c: ClusterJobParams = {
      limit,
      ...(ids && ids.length > 0 ? { clusterIds: ids } : {}),
    }
    params = c
    if (ids && ids.length > 0) {
      // Explicit list → known total at enqueue time.
      totalTarget = Math.min(ids.length, limit)
    }
  }

  try {
    const supabase = createAdminClient()
    const job = await enqueueJob(supabase, {
      kind: body.kind,
      params,
      totalTarget,
    })
    return NextResponse.json({ job }, { status: 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("admin-classification-jobs", "enqueue_failed", error, {
      kind: body.kind,
    })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
