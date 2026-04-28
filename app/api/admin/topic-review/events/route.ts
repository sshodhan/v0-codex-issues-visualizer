import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  isReasonCode,
  isReviewStatus,
  isSuggestedAction,
  isSuggestedLayer,
} from "@/lib/admin/topic-review"
import { logServerError } from "@/lib/error-tracking/server-logger"

// GET /api/admin/topic-review/events
//
// Lists recent topic_review_events with optional filters. Read-only.
// Joined with observations.title so the UI can render a list view
// without an extra round-trip.

export const maxDuration = 30
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

interface ReviewEventRow {
  id: string
  created_at: string
  reviewer: string
  observation_id: string
  original_topic_slug: string | null
  corrected_topic_slug: string | null
  reason_code: string
  suggested_layer: string
  suggested_action: string
  phrase_candidate: string | null
  rationale: string | null
  status: string
}

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const url = new URL(request.url)
  const status = url.searchParams.get("status")?.trim() || null
  const suggestedLayer =
    url.searchParams.get("suggestedLayer")?.trim() || null
  const suggestedAction =
    url.searchParams.get("suggestedAction")?.trim() || null
  const reasonCode = url.searchParams.get("reasonCode")?.trim() || null
  const limitRaw = Number(url.searchParams.get("limit"))
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(limitRaw, MAX_LIMIT))
    : DEFAULT_LIMIT

  if (status && !isReviewStatus(status)) {
    return NextResponse.json(
      { error: `Invalid status: ${status}` },
      { status: 400 },
    )
  }
  if (suggestedLayer && !isSuggestedLayer(suggestedLayer)) {
    return NextResponse.json(
      { error: `Invalid suggestedLayer: ${suggestedLayer}` },
      { status: 400 },
    )
  }
  if (suggestedAction && !isSuggestedAction(suggestedAction)) {
    return NextResponse.json(
      { error: `Invalid suggestedAction: ${suggestedAction}` },
      { status: 400 },
    )
  }
  if (reasonCode && !isReasonCode(reasonCode)) {
    return NextResponse.json(
      { error: `Invalid reasonCode: ${reasonCode}` },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()

  let q = supabase
    .from("topic_review_events")
    .select(
      "id, created_at, reviewer, observation_id, original_topic_slug, corrected_topic_slug, reason_code, suggested_layer, suggested_action, phrase_candidate, rationale, status",
    )
    .order("created_at", { ascending: false })
    .limit(limit)
  if (status) q = q.eq("status", status)
  if (suggestedLayer) q = q.eq("suggested_layer", suggestedLayer)
  if (suggestedAction) q = q.eq("suggested_action", suggestedAction)
  if (reasonCode) q = q.eq("reason_code", reasonCode)

  const eventsRes = await q
  if (eventsRes.error) {
    logServerError(
      "admin-topic-review",
      "events_query_failed",
      eventsRes.error,
      { status, suggestedLayer, suggestedAction, reasonCode, limit },
    )
    return NextResponse.json(
      { error: "Events query failed", detail: eventsRes.error.message },
      { status: 500 },
    )
  }
  const events = (eventsRes.data ?? []) as ReviewEventRow[]

  const obsIds = Array.from(new Set(events.map((e) => e.observation_id)))
  const titleByObs = new Map<string, string | null>()
  if (obsIds.length > 0) {
    const obsRes = await supabase
      .from("observations")
      .select("id, title")
      .in("id", obsIds)
    if (obsRes.error) {
      logServerError(
        "admin-topic-review",
        "events_observation_lookup_failed",
        obsRes.error,
        { observationCount: obsIds.length },
      )
    } else if (obsRes.data) {
      for (const row of obsRes.data as Array<{ id: string; title: string | null }>) {
        titleByObs.set(row.id, row.title)
      }
    }
  }

  const rows = events.map((e) => ({
    id: e.id,
    created_at: e.created_at,
    reviewer: e.reviewer,
    observation_id: e.observation_id,
    observation_title: titleByObs.get(e.observation_id) ?? null,
    original_topic_slug: e.original_topic_slug,
    corrected_topic_slug: e.corrected_topic_slug,
    reason_code: e.reason_code,
    suggested_layer: e.suggested_layer,
    suggested_action: e.suggested_action,
    phrase_candidate: e.phrase_candidate,
    rationale: e.rationale,
    status: e.status,
  }))

  return NextResponse.json({ rows, total: rows.length, limit })
}
