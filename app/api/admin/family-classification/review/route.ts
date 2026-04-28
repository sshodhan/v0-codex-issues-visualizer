import { NextRequest, NextResponse } from "next/server"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  ERROR_LAYERS,
  ERROR_REASONS,
  REVIEW_VERDICTS,
  QUALITY_BUCKET_VALUES,
  summarizeFamilyReviewRows,
  validateFamilyClassificationReviewInput,
  type FamilyReviewSummaryRow,
} from "@/lib/admin/family-classification-review"
import { createAdminClient } from "@/lib/supabase/admin"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Family Classification QA Reviews — append-only reviewer feedback.
//
// POST inserts one row into `family_classification_reviews`. It does
// NOT mutate `family_classifications`, does NOT change quality buckets,
// and does NOT trigger any external workflow. Reviews are evaluation
// signal, not a ticketing surface — see docs/CLUSTERING_DESIGN.md §5.2.
//
// GET returns the latest review per classification (filtered) plus a
// summary block the dashboard renders into precision-style tiles.

export const maxDuration = 60

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const REVIEW_VERDICT_SET = new Set<string>(REVIEW_VERDICTS as readonly string[])
const ERROR_LAYER_SET = new Set<string>(ERROR_LAYERS as readonly string[])
const ERROR_REASON_SET = new Set<string>(ERROR_REASONS as readonly string[])
const QUALITY_BUCKET_SET = new Set<string>(QUALITY_BUCKET_VALUES as readonly string[])

interface ReviewRow {
  id: string
  classification_id: string
  cluster_id: string
  review_verdict: string
  expected_family_kind: string | null
  actual_family_kind: string | null
  quality_bucket: string | null
  error_layer: string | null
  error_reason: string | null
  notes: string | null
  reviewed_by: string | null
  reviewed_at: string
  evidence_snapshot: Record<string, unknown> | null
}

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(parsed, MAX_LIMIT))
}

export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const result = validateFamilyClassificationReviewInput(
    (body ?? {}) as Record<string, unknown>,
  )
  if (!result.ok) {
    logServer({
      component: "admin-family-classification-review",
      event: "post_invalid",
      level: "warn",
      data: { errors: result.errors },
    })
    return NextResponse.json(
      { error: "Invalid review input", details: result.errors },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from("family_classification_reviews")
    .insert(result.value)
    .select()
    .single()

  if (error) {
    logServerError(
      "admin-family-classification-review",
      "post_insert_failed",
      error,
      {
        classification_id: result.value.classification_id,
        cluster_id: result.value.cluster_id,
        review_verdict: result.value.review_verdict,
      },
    )
    return NextResponse.json(
      { error: "Failed to record review", details: error.message },
      { status: 500 },
    )
  }

  logServer({
    component: "admin-family-classification-review",
    event: "post_succeeded",
    level: "info",
    data: {
      classification_id: result.value.classification_id,
      cluster_id: result.value.cluster_id,
      review_verdict: result.value.review_verdict,
      error_layer: result.value.error_layer,
      error_reason: result.value.error_reason,
      quality_bucket: result.value.quality_bucket,
    },
  })

  return NextResponse.json({ ok: true, review: data })
}

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const url = new URL(request.url)
  const limit = parseLimit(url.searchParams.get("limit"))
  const classificationId = url.searchParams.get("classificationId")?.trim() || null
  const clusterId = url.searchParams.get("clusterId")?.trim() || null
  const verdict = url.searchParams.get("verdict")?.trim() || null
  const qualityBucket = url.searchParams.get("qualityBucket")?.trim() || null
  const errorLayer = url.searchParams.get("errorLayer")?.trim() || null
  const errorReason = url.searchParams.get("errorReason")?.trim() || null

  // Reject filter values that aren't in the canonical sets so the API
  // surface stays small (no SQL injection here — Supabase parameterizes
  // — but the 400 catches typos and stops them from looking like "no
  // results found" to the operator).
  if (verdict && !REVIEW_VERDICT_SET.has(verdict)) {
    return NextResponse.json(
      { error: `verdict must be one of: ${[...REVIEW_VERDICT_SET].join(", ")}` },
      { status: 400 },
    )
  }
  if (qualityBucket && !QUALITY_BUCKET_SET.has(qualityBucket)) {
    return NextResponse.json(
      {
        error: `qualityBucket must be one of: ${[...QUALITY_BUCKET_SET].join(", ")}`,
      },
      { status: 400 },
    )
  }
  if (errorLayer && !ERROR_LAYER_SET.has(errorLayer)) {
    return NextResponse.json(
      { error: `errorLayer must be one of: ${[...ERROR_LAYER_SET].join(", ")}` },
      { status: 400 },
    )
  }
  if (errorReason && !ERROR_REASON_SET.has(errorReason)) {
    return NextResponse.json(
      {
        error: `errorReason must be one of: ${[...ERROR_REASON_SET].join(", ")}`,
      },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()

  // Latest-per-classification view powers the row list. We always pull
  // a generous summary set (up to 5000 rows, parity with the quality
  // route) so the precision tiles aren't artificially zeroed out by a
  // narrow limit, and slice the row payload at the end.
  let query = supabase
    .from("family_classification_review_current")
    .select(
      "id, classification_id, cluster_id, review_verdict, expected_family_kind, actual_family_kind, quality_bucket, error_layer, error_reason, notes, reviewed_by, reviewed_at, evidence_snapshot",
    )
    .order("reviewed_at", { ascending: false })
    .limit(5000)

  if (classificationId) query = query.eq("classification_id", classificationId)
  if (clusterId) query = query.eq("cluster_id", clusterId)
  if (verdict) query = query.eq("review_verdict", verdict)
  if (qualityBucket) query = query.eq("quality_bucket", qualityBucket)
  if (errorLayer) query = query.eq("error_layer", errorLayer)
  if (errorReason) query = query.eq("error_reason", errorReason)

  const { data, error } = await query

  if (error) {
    logServerError(
      "admin-family-classification-review",
      "get_failed",
      error,
      {
        classificationId,
        clusterId,
        verdict,
      },
    )
    return NextResponse.json(
      { error: "Failed to load reviews", details: error.message },
      { status: 500 },
    )
  }

  const rows = (data ?? []) as ReviewRow[]
  const summaryRows: FamilyReviewSummaryRow[] = rows.map((r) => ({
    review_verdict: r.review_verdict,
    quality_bucket: r.quality_bucket,
    error_layer: r.error_layer,
    error_reason: r.error_reason,
  }))
  const summary = summarizeFamilyReviewRows(summaryRows)

  return NextResponse.json({
    rows: rows.slice(0, limit),
    summary,
  })
}
