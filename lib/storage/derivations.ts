import type { createAdminClient } from "@/lib/supabase/admin"
import { CURRENT_VERSIONS, LEXICON_VERSION } from "@/lib/storage/algorithm-versions"

// The only module permitted to write to the derivation layer.
// Every write is stamped with algorithm_version; derivations are immutable
// after insert. Algorithm bumps insert new rows (unique on
// (observation_id, algorithm_version)) — old rows remain for replay.
// See docs/ARCHITECTURE.md v10 §§3.1b, 5.2, 7.4.

type AdminClient = ReturnType<typeof createAdminClient>

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
): Promise<void> {
  const { error } = await supabase.rpc("record_category", {
    obs_id: observationId,
    ver: CURRENT_VERSIONS.category,
    cat_id: categoryId,
    conf: confidence,
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
  return data as string | null
}

export interface ClassificationReviewPayload {
  status?: string
  category?: string
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
  return data as string | null
}
