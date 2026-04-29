import type { createAdminClient } from "@/lib/supabase/admin"
import {
  buildGoldenSetCandidate,
  buildManualOverrideEvidence,
  isReasonCode,
  isSuggestedAction,
  isSuggestedLayer,
  type GoldenSetCandidate,
  type TopicReviewReasonCode,
  type TopicReviewSuggestedAction,
  type TopicReviewSuggestedLayer,
} from "@/lib/admin/topic-review"

// Admin Review Loop — storage helper for topic_review_events + manual
// overrides. The only module permitted to write to either surface from
// the admin path. Both writes route through SECURITY DEFINER RPCs
// (record_topic_review_event, record_manual_topic_override) so the same
// row-level-security model used by the rest of the evidence/derivation
// stack continues to apply (§5.1, §5.6).
//
// Behavioural contract:
//   * Always inserts a topic_review_events row.
//   * Optionally appends a manual category_assignments row when
//     applyManualOverride === true. Manual overrides are append-only:
//     the v6 deterministic row is left intact; mv_observation_current's
//     latest_category CTE picks the more recent computed_at, so the
//     manual row wins on read.
//   * Builds evidence_snapshot from the latest deterministic assignment
//     (whatever evidence shape is on file — the v5/v6 TopicEvidence
//     JSONB, or null on pre-v5 rows).
//   * Builds golden_set_candidate { title, body, expected } from the
//     current observation title/body. `expected` prefers the corrected
//     slug; falls back to the current slug so a "manual_override_only"
//     review (no correction) still seeds a candidate row.
//   * Does NOT mutate CATEGORY_PATTERNS, the golden-set fixture, or any
//     classifier configuration. Future automation reads these rows and
//     PROPOSES changes — humans still review them.

type AdminClient = ReturnType<typeof createAdminClient>

export interface RecordTopicReviewEventArgs {
  observationId: string
  correctedCategorySlug?: string | null
  applyManualOverride?: boolean
  reasonCode: TopicReviewReasonCode
  suggestedLayer: TopicReviewSuggestedLayer
  suggestedAction: TopicReviewSuggestedAction
  phraseCandidate?: string | null
  rationale?: string | null
  reviewer?: string
}

export interface RecordTopicReviewEventResult {
  reviewEventId: string
  manualOverrideApplied: boolean
  goldenSetCandidate: GoldenSetCandidate | null
  originalSlug: string | null
  correctedSlug: string | null
}

interface LatestAssignmentRow {
  algorithm_version: string | null
  category_id: string | null
  confidence: number | null
  evidence: unknown
  categories: { slug: string } | null
}

interface ObservationRow {
  id: string
  title: string | null
  content: string | null
}

interface CategoryRow {
  id: string
  slug: string
}

class TopicReviewError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export { TopicReviewError }

export async function recordTopicReviewEvent(
  supabase: AdminClient,
  args: RecordTopicReviewEventArgs,
): Promise<RecordTopicReviewEventResult> {
  // ---- Validate enums up front so a bad payload never reaches the DB.
  if (!isReasonCode(args.reasonCode)) {
    throw new TopicReviewError(
      `Invalid reason_code: ${String(args.reasonCode)}`,
      400,
    )
  }
  if (!isSuggestedLayer(args.suggestedLayer)) {
    throw new TopicReviewError(
      `Invalid suggested_layer: ${String(args.suggestedLayer)}`,
      400,
    )
  }
  if (!isSuggestedAction(args.suggestedAction)) {
    throw new TopicReviewError(
      `Invalid suggested_action: ${String(args.suggestedAction)}`,
      400,
    )
  }
  if (!args.observationId || typeof args.observationId !== "string") {
    throw new TopicReviewError("observationId is required", 400)
  }
  const correctedSlugInput = args.correctedCategorySlug?.trim() || null
  if (args.applyManualOverride && !correctedSlugInput) {
    throw new TopicReviewError(
      "correctedCategorySlug is required when applyManualOverride is true",
      400,
    )
  }

  // ---- Pull the observation (title/body for golden-set candidate).
  const obsRes = await supabase
    .from("observations")
    .select("id, title, content")
    .eq("id", args.observationId)
    .maybeSingle<ObservationRow>()

  if (obsRes.error) {
    throw new TopicReviewError(
      `Observation lookup failed: ${obsRes.error.message}`,
      500,
    )
  }
  if (!obsRes.data) {
    throw new TopicReviewError("Observation not found", 404)
  }
  const observation = obsRes.data

  // ---- Latest deterministic category assignment (skip 'manual' rows so
  //      the snapshot reflects what the CLASSIFIER said, not a previous
  //      reviewer override). Joins categories.slug for human-readable
  //      original_topic_slug.
  const latestRes = await supabase
    .from("category_assignments")
    .select(
      "algorithm_version, category_id, confidence, evidence, categories:category_id(slug)",
    )
    .eq("observation_id", args.observationId)
    .neq("algorithm_version", "manual")
    .order("computed_at", { ascending: false })
    .limit(1)

  if (latestRes.error) {
    throw new TopicReviewError(
      `Latest category lookup failed: ${latestRes.error.message}`,
      500,
    )
  }
  const latestRow =
    (latestRes.data?.[0] as unknown as LatestAssignmentRow | undefined) ?? null

  const originalSlug = latestRow?.categories?.slug ?? null
  const originalCategoryId = latestRow?.category_id ?? null
  const evidenceSnapshot = latestRow?.evidence ?? null

  // ---- Resolve corrected slug → categories.id (when provided).
  let correctedCategoryId: string | null = null
  let correctedSlug: string | null = null
  if (correctedSlugInput) {
    const catRes = await supabase
      .from("categories")
      .select("id, slug")
      .eq("slug", correctedSlugInput)
      .maybeSingle<CategoryRow>()
    if (catRes.error) {
      throw new TopicReviewError(
        `Category lookup failed: ${catRes.error.message}`,
        500,
      )
    }
    if (!catRes.data) {
      throw new TopicReviewError(
        `Unknown corrected category slug: ${correctedSlugInput}`,
        400,
      )
    }
    correctedCategoryId = catRes.data.id
    correctedSlug = catRes.data.slug
  }

  // ---- Build the structured-learning fields BEFORE any write so the
  //      review event row carries them even if the override write fails.
  const goldenSetCandidate = buildGoldenSetCandidate({
    title: observation.title ?? "",
    body: observation.content ?? "",
    correctedSlug,
    currentSlug: originalSlug,
  })

  const reviewer = args.reviewer?.trim() || "local_admin"

  // ---- Append the topic_review_events row first. If the optional manual
  //      override fails afterwards, the structured signal is still
  //      captured, which is the primary value of this loop.
  const eventRes = await supabase.rpc("record_topic_review_event", {
    payload: {
      observation_id: args.observationId,
      reviewer,
      original_category_id: originalCategoryId,
      original_topic_slug: originalSlug,
      corrected_category_id: correctedCategoryId,
      corrected_topic_slug: correctedSlug,
      reason_code: args.reasonCode,
      suggested_layer: args.suggestedLayer,
      suggested_action: args.suggestedAction,
      phrase_candidate: args.phraseCandidate?.trim() || null,
      rationale: args.rationale?.trim() || null,
      golden_set_candidate: goldenSetCandidate as unknown,
      evidence_snapshot: evidenceSnapshot as unknown,
    } as unknown as Record<string, unknown>,
  })

  if (eventRes.error || !eventRes.data) {
    throw new TopicReviewError(
      `record_topic_review_event failed: ${eventRes.error?.message ?? "no id returned"}`,
      500,
    )
  }
  const reviewEventId = eventRes.data as string

  // ---- Optional manual override append.
  let manualOverrideApplied = false
  if (args.applyManualOverride && correctedCategoryId && correctedSlug) {
    const evidence = buildManualOverrideEvidence({
      overriddenAssignment: {
        algorithmVersion: latestRow?.algorithm_version ?? null,
        categoryId: latestRow?.category_id ?? null,
        slug: originalSlug,
        confidence: latestRow?.confidence ?? null,
      },
      corrected: { categoryId: correctedCategoryId, slug: correctedSlug },
      reasonCode: args.reasonCode,
      suggestedLayer: args.suggestedLayer,
      suggestedAction: args.suggestedAction,
      rationale: args.rationale?.trim() || null,
      reviewer,
    })
    const overrideRes = await supabase.rpc("record_manual_topic_override", {
      obs_id: args.observationId,
      cat_id: correctedCategoryId,
      ev: evidence as unknown as Record<string, unknown>,
    })
    if (overrideRes.error) {
      throw new TopicReviewError(
        `record_manual_topic_override failed: ${overrideRes.error.message}`,
        500,
      )
    }
    manualOverrideApplied = true
  }

  return {
    reviewEventId,
    manualOverrideApplied,
    goldenSetCandidate,
    originalSlug,
    correctedSlug,
  }
}
