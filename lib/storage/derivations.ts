import type { createAdminClient } from "@/lib/supabase/admin"
import { CURRENT_VERSIONS, LEXICON_VERSION } from "@/lib/storage/algorithm-versions"
import { recordProcessingEvent } from "@/lib/storage/processing-events"

// The only module permitted to write to the derivation layer.
// Every write is stamped with algorithm_version; derivations are immutable
// after insert. Algorithm bumps insert new rows (unique on
// (observation_id, algorithm_version)) — old rows remain for replay.
// See docs/ARCHITECTURE.md v10 §§3.1b, 5.2, 7.4.

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Phase 4 staleness marker.
 *
 * When a classification or review is written for an observation that
 * already has an `observation_embeddings` row at the current
 * `observation_embedding` algorithm version, the embedding's content
 * is now stale relative to the new classification. Emit a
 * `processing_events` row so the next admin cluster rebuild (with
 * `?include_stale=true`) re-embeds this observation.
 *
 * Why this exists:
 *   v3 embeddings encode LLM 4.a category/subcategory/tags + reviewer
 *   override. Without staleness markers, `ensureEmbedding` would
 *   return the cached pre-classification vector forever. The
 *   convergence model in `docs/CLASSIFICATION_EVOLUTION_PLAN.md`
 *   Phase 4 §"Stage 4a / Stage 2 sequencing model" specifies that
 *   rebuilds are the convergence point — markers tell the rebuild
 *   which rows to recompute.
 *
 * Best-effort: a failure here doesn't block the calling write
 * (classification or review). The embedding stays stale until the
 * next manual re-embed. The marker emit is a hint, not a
 * correctness guarantee — at-least-once consistency is the design.
 *
 * No-op when the observation has no v3 embedding yet (the next
 * `ensureEmbedding` call on a cold cache produces a fresh v3 row
 * anyway).
 */
async function emitEmbeddingStaleMarkerIfNeeded(
  supabase: AdminClient,
  observationId: string,
  reason: "classification_updated" | "review_updated",
): Promise<void> {
  if (!observationId) return

  const { data, error } = await supabase
    .from("observation_embeddings")
    .select("created_at")
    .eq("observation_id", observationId)
    .eq("algorithm_version", CURRENT_VERSIONS.observation_embedding)
    .maybeSingle()

  if (error) {
    // Best-effort: log + continue. The classification write itself
    // succeeded; the embedding's freshness is a downstream concern.
    console.error("[derivations] embedding staleness check failed:", error)
    return
  }

  if (!data) {
    // No embedding at the current version — nothing to mark stale.
    // The next ensureEmbedding will compute fresh using the new
    // classification.
    return
  }

  // There IS an embedding, and a classification/review just changed
  // for the same observation. Emit the stale marker.
  await recordProcessingEvent(supabase, {
    observationId,
    stage: "embedding",
    status: "stale",
    algorithmVersionModel: `${CURRENT_VERSIONS.observation_embedding}:upstream-changed`,
    detail: { reason, marked_at: new Date().toISOString() },
  })
}

/**
 * Look up the `observation_id` for a given classification_id. Used
 * by recordClassificationReview to find the observation a review
 * targets, so we can emit a staleness marker for the right embedding.
 */
async function observationIdForClassification(
  supabase: AdminClient,
  classificationId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("classifications")
    .select("observation_id")
    .eq("id", classificationId)
    .maybeSingle()
  if (error || !data) return null
  return (data as { observation_id: string | null }).observation_id ?? null
}

export type SentimentLabel = "positive" | "negative" | "neutral"

export async function recordSentiment(
  supabase: AdminClient,
  observationId: string,
  result: { label: SentimentLabel; score: number; keyword_presence: number },
): Promise<void> {
  const { error } = await supabase.rpc("record_sentiment", {
    obs_id: observationId,
    ver: CURRENT_VERSIONS.sentiment,
    s: result.score,
    lbl: result.label,
    kp: result.keyword_presence,
  })
  if (error) console.error("[derivations] record_sentiment failed:", error)
}

export async function recordCategory(
  supabase: AdminClient,
  observationId: string,
  categoryId: string,
  confidence = 1.0,
  evidence: unknown = null,
): Promise<void> {
  const { error } = await supabase.rpc("record_category", {
    obs_id: observationId,
    ver: CURRENT_VERSIONS.category,
    cat_id: categoryId,
    conf: confidence,
    ev: evidence as any,
  })
  if (error) console.error("[derivations] record_category failed:", error)
}

// Every column of `inputs` is persisted as-is into impact_scores.inputs_jsonb
// and must be sufficient to recompute the score from captured evidence
// alone (ARCHITECTURE.md §3.1b). `source_slug` was added in impact v2
// alongside the source-authority multiplier — it is nullable so v1 callers
// and unknown sources still work.
export async function recordImpact(
  supabase: AdminClient,
  observationId: string,
  score: number,
  inputs: {
    upvotes: number
    comments_count: number
    sentiment_label: SentimentLabel
    source_slug?: string | null
  },
): Promise<void> {
  const { error } = await supabase.rpc("record_impact", {
    obs_id: observationId,
    ver: CURRENT_VERSIONS.impact,
    s: score,
    inputs,
  })
  if (error) console.error("[derivations] record_impact failed:", error)
}

export async function recordCompetitorMention(
  supabase: AdminClient,
  observationId: string,
  mention: {
    competitor: string
    sentence_window: string | null
    sentiment_score: number | null
    confidence: number | null
  },
): Promise<void> {
  const { error } = await supabase.rpc("record_competitor_mention", {
    obs_id: observationId,
    comp: mention.competitor,
    win_text: mention.sentence_window,
    sent: mention.sentiment_score,
    conf: mention.confidence,
    lex_ver: LEXICON_VERSION,
    alg_ver: CURRENT_VERSIONS.competitor_mention,
  })
  if (error) console.error("[derivations] record_competitor_mention failed:", error)
}

// Bug-fingerprint payload mirrors the BugFingerprint shape in
// lib/scrapers/bug-fingerprint.ts, plus the compound cluster-key label
// derived from it at compute time. Persisted for replay / audit.
//
// Note: the LLM classifier's output is intentionally NOT denormalized
// onto this row. `classifications` is the source of truth for
// subcategory / tags / severity / root_cause_hypothesis, and
// mv_observation_current joins directly to it so dashboards never see
// stale LLM fields.
export interface BugFingerprintPayload {
  error_code: string | null
  top_stack_frame: string | null
  top_stack_frame_hash: string | null
  cli_version: string | null
  os: string | null
  shell: string | null
  editor: string | null
  model_id: string | null
  repro_markers: number
  keyword_presence: number
  cluster_key_compound: string | null
}

export async function recordBugFingerprint(
  supabase: AdminClient,
  observationId: string,
  payload: BugFingerprintPayload,
): Promise<void> {
  const { error } = await supabase.rpc("record_bug_fingerprint", {
    obs_id: observationId,
    ver: CURRENT_VERSIONS.bug_fingerprint,
    payload: payload as any,
  })
  if (error) console.error("[derivations] record_bug_fingerprint failed:", error)
}

export interface ClassificationPayload {
  observation_id?: string | null
  prior_classification_id?: string | null
  report_text: string
  category: string
  subcategory: string
  severity: string
  status: string
  reproducibility: string
  impact: string
  confidence: number
  summary: string
  root_cause_hypothesis: string
  suggested_fix: string
  evidence_quotes: string[]
  alternate_categories: string[]
  tags: string[]
  needs_human_review: boolean
  review_reasons: string[]
  model_used: string | null
  retried_with_large_model: boolean
  raw_json: unknown
}

export async function recordClassification(
  supabase: AdminClient,
  payload: ClassificationPayload,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("record_classification", {
    payload: {
      ...payload,
      algorithm_version: CURRENT_VERSIONS.classification,
    } as any,
  })
  if (error) {
    console.error("[derivations] record_classification failed:", error)
    return null
  }

  // Phase 4 staleness marker: if this observation already has an
  // embedding at the current observation_embedding algorithm version,
  // the new classification means the embedding's content is stale.
  // Emit a processing_events row so the next admin cluster rebuild
  // (with ?include_stale=true) re-embeds this observation. Same
  // pattern for recordClassificationReview below — both paths
  // invalidate the embedding's content.
  //
  // Best-effort: a failure here doesn't block the classification
  // write, but the embedding will remain stale until manually
  // re-embedded. Convergence model documented in
  // docs/CLASSIFICATION_EVOLUTION_PLAN.md Phase 4 §"Stage 4a /
  // Stage 2 sequencing model".
  if (payload.observation_id) {
    await emitEmbeddingStaleMarkerIfNeeded(
      supabase,
      payload.observation_id,
      "classification_updated",
    )
  }

  return data as string | null
}

export interface ClassificationReviewPayload {
  status?: string
  category?: string
  // subcategory override added in scripts/020_classification_reviews_add_subcategory.sql.
  // Optional; absent means "reviewer did not override; effective_subcategory
  // falls back to the baseline classifications.subcategory".
  subcategory?: string
  severity?: string
  needs_human_review?: boolean
  reviewer_notes?: string
  reviewed_by: string
}

export async function recordClassificationReview(
  supabase: AdminClient,
  classificationId: string,
  review: ClassificationReviewPayload,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("record_classification_review", {
    cls_id: classificationId,
    payload: review as any,
  })
  if (error) {
    console.error("[derivations] record_classification_review failed:", error)
    return null
  }

  // Phase 4 staleness marker. A review override changes what the
  // v3 helper considers the "effective" category/subcategory for the
  // observation, so the existing embedding is now stale. Resolve
  // observation_id from classification_id (review_payload doesn't
  // carry it directly), then emit. Best-effort.
  const observationId = await observationIdForClassification(supabase, classificationId)
  if (observationId) {
    await emitEmbeddingStaleMarkerIfNeeded(supabase, observationId, "review_updated")
  }

  return data as string | null
}
