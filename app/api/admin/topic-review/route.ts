import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  isReasonCode,
  isSuggestedAction,
  isSuggestedLayer,
} from "@/lib/admin/topic-review"
import {
  recordTopicReviewEvent,
  TopicReviewError,
} from "@/lib/storage/topic-review"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

export const maxDuration = 30

interface PostBody {
  observationId?: string
  correctedCategorySlug?: string
  applyManualOverride?: boolean
  reasonCode?: string
  suggestedLayer?: string
  suggestedAction?: string
  phraseCandidate?: string
  rationale?: string
  reviewer?: string
}

export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  let body: PostBody
  try {
    body = (await request.json()) as PostBody
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  if (!body.observationId || typeof body.observationId !== "string") {
    return NextResponse.json(
      { error: "observationId is required" },
      { status: 400 },
    )
  }
  if (!isReasonCode(body.reasonCode)) {
    return NextResponse.json(
      { error: "reasonCode is required and must be an allowed value" },
      { status: 400 },
    )
  }
  if (!isSuggestedLayer(body.suggestedLayer)) {
    return NextResponse.json(
      { error: "suggestedLayer is required and must be an allowed value" },
      { status: 400 },
    )
  }
  if (!isSuggestedAction(body.suggestedAction)) {
    return NextResponse.json(
      { error: "suggestedAction is required and must be an allowed value" },
      { status: 400 },
    )
  }
  if (
    body.applyManualOverride === true &&
    (!body.correctedCategorySlug || !body.correctedCategorySlug.trim())
  ) {
    return NextResponse.json(
      {
        error:
          "correctedCategorySlug is required when applyManualOverride is true",
      },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()
  try {
    const result = await recordTopicReviewEvent(supabase, {
      observationId: body.observationId,
      correctedCategorySlug: body.correctedCategorySlug ?? null,
      applyManualOverride: body.applyManualOverride === true,
      reasonCode: body.reasonCode,
      suggestedLayer: body.suggestedLayer,
      suggestedAction: body.suggestedAction,
      phraseCandidate: body.phraseCandidate ?? null,
      rationale: body.rationale ?? null,
      reviewer: body.reviewer,
    })

    logServer({
      component: "admin-topic-review",
      event: "review_event_recorded",
      level: "info",
      data: {
        observationId: body.observationId,
        reviewEventId: result.reviewEventId,
        manualOverrideApplied: result.manualOverrideApplied,
        reasonCode: body.reasonCode,
        suggestedLayer: body.suggestedLayer,
        suggestedAction: body.suggestedAction,
      },
    })

    // If we appended a manual override, refresh mv_observation_current
    // so the dashboard reflects the new effective category. Best-effort:
    // a refresh failure is logged but does not fail the request — the
    // append-only writes already landed.
    if (result.manualOverrideApplied) {
      const { error: refreshErr } = await supabase.rpc(
        "refresh_materialized_views",
      )
      if (refreshErr) {
        logServerError("admin-topic-review", "mv_refresh_failed", refreshErr)
      }
    }

    return NextResponse.json({
      ok: true,
      reviewEventId: result.reviewEventId,
      manualOverrideApplied: result.manualOverrideApplied,
      goldenSetCandidate: result.goldenSetCandidate,
      originalSlug: result.originalSlug,
      correctedSlug: result.correctedSlug,
    })
  } catch (err) {
    if (err instanceof TopicReviewError) {
      // 4xx errors are operator typos (bad slug, missing observation,
      // unknown enum) — surface in HTTP response only, no log noise.
      // 5xx errors come from Supabase failures inside the storage
      // helper and DO need to surface in Vercel logs so operators can
      // see DB drift / RLS misconfiguration.
      if (err.status >= 500) {
        logServerError("admin-topic-review", "record_failed", err, {
          observationId: body.observationId,
          reasonCode: body.reasonCode,
          suggestedLayer: body.suggestedLayer,
          suggestedAction: body.suggestedAction,
          applyManualOverride: body.applyManualOverride,
        })
      }
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    logServerError("admin-topic-review", "record_failed", err, {
      observationId: body.observationId,
    })
    return NextResponse.json(
      {
        error: "Failed to record topic review event",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
