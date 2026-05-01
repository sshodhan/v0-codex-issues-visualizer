import {
  bucketConfidence,
  canUseTaxonomySignals,
  type ConfidenceBucket,
} from "./classification-aware-input.ts"

/** Row shape consumed by `summarizeEmbeddingSignalCoverage`. The caller
 *  is responsible for materializing `category_slug` (resolve via
 *  `category_assignments` → `categories.slug` join — `mv_observation_current`
 *  itself only carries `category_id`) and `review_flagged` (boolean,
 *  computed from `classification_reviews.needs_human_review` /
 *  `classification_reviews.status` — the MV does NOT carry an
 *  `llm_review_status` column). Documenting the upstream sources here
 *  is what prevents the next caller from drifting back toward reading
 *  fields directly off the MV that don't exist. */
export interface EmbeddingSignalCoverageRow {
  observation_id: string
  title?: string | null
  content?: string | null
  /** Resolved by the caller via category_id → categories.slug. */
  category_slug?: string | null
  error_code?: string | null
  top_stack_frame?: string | null
  cli_version?: string | null
  fp_os?: string | null
  fp_shell?: string | null
  fp_editor?: string | null
  model_id?: string | null
  /** `bug_fingerprints.repro_markers` is `integer not null default 0`. */
  repro_markers?: number | null
  llm_category?: string | null
  llm_subcategory?: string | null
  llm_primary_tag?: string | null
  /** `classifications.confidence` is `numeric(3,2)` returned as either
   *  number (server-side) or JSON string (PostgREST client). */
  llm_confidence?: number | string | null
  /** Resolved by the caller from `classification_reviews`
   *  (needs_human_review = true OR status in {flagged, rejected, needs_review}). */
  review_flagged?: boolean | null
  /** Reviewer-corrected category/subcategory, when a review row exists. */
  reviewer_category?: string | null
  reviewer_subcategory?: string | null
}

export interface EmbeddingSignalCoveragePreview {
  observation_id: string
  included_fields: string[]
  omitted_reasons: string[]
}

export interface EmbeddingSignalCoverageSummary {
  total_observations: number
  with_topic: number
  with_bug_fingerprint: number
  with_any_llm_classification: number
  /** Diagnostic: rows where the LLM bucket is "high" regardless of
   *  review state. Useful for spotting "good LLM output rejected by
   *  reviewer" cases. NOT the gate signal — see
   *  `with_usable_taxonomy_triplet`. */
  with_high_confidence_llm_classification: number
  with_review_flagged_llm_classification: number
  /** Gate signal: rows that pass `canUseTaxonomySignals` AND have at
   *  least one of category/subcategory/primary_tag populated. This is
   *  what Phase 4 will actually embed; the Phase 2 decision gate must
   *  be evaluated against this number, not the unfiltered "high
   *  confidence" diagnostic. */
  with_usable_taxonomy_triplet: number
  raw_only_fallback_count: number
  llm_category_distribution: Record<string, number>
  llm_subcategory_distribution: Record<string, number>
  topic_distribution: Record<string, number>
  /** Histogram of confidence buckets across the sample, computed via
   *  `bucketConfidence`. Adding this so an operator looking at the
   *  output can verify that the bucket boundaries are dividing the
   *  data sensibly without round-tripping through SQL. */
  confidence_bucket_distribution: Record<ConfidenceBucket, number>
}

const TOP_K_DISTRIBUTION = 20

function isPresent(v?: string | null): boolean {
  return Boolean(v && v.trim())
}

/** Reduce an unbounded distribution object to the top-N keys plus an
 *  "_other" bucket. With LLM-generated category/subcategory strings
 *  that vary by typo / casing / hallucination, a 5000-row sample can
 *  produce hundreds of unique keys with count=1 — the long tail is
 *  noise, not signal, and bloats the response. */
function topN(d: Record<string, number>, n = TOP_K_DISTRIBUTION): Record<string, number> {
  const entries = Object.entries(d).sort((a, b) => b[1] - a[1])
  const head = entries.slice(0, n)
  const tail = entries.slice(n)
  const tailSum = tail.reduce((s, [, v]) => s + v, 0)
  const out: Record<string, number> = Object.fromEntries(head)
  if (tailSum > 0) out._other = tailSum
  return out
}

/** Build the `classification` shape the helper expects from the row's
 *  raw signals. Used by both the metric (to evaluate
 *  `canUseTaxonomySignals` consistently) and the preview (to label
 *  the omission reasons identically). */
function classificationFromRow(row: EmbeddingSignalCoverageRow) {
  return {
    category: row.llm_category ?? null,
    subcategory: row.llm_subcategory ?? null,
    confidence_bucket: bucketConfidence(row.llm_confidence),
    review_flagged: Boolean(row.review_flagged),
    reviewer_category: row.reviewer_category ?? null,
    reviewer_subcategory: row.reviewer_subcategory ?? null,
  }
}

export function summarizeEmbeddingSignalCoverage(
  rows: EmbeddingSignalCoverageRow[],
): EmbeddingSignalCoverageSummary {
  const summary: EmbeddingSignalCoverageSummary = {
    total_observations: rows.length,
    with_topic: 0,
    with_bug_fingerprint: 0,
    with_any_llm_classification: 0,
    with_high_confidence_llm_classification: 0,
    with_review_flagged_llm_classification: 0,
    with_usable_taxonomy_triplet: 0,
    raw_only_fallback_count: 0,
    llm_category_distribution: {},
    llm_subcategory_distribution: {},
    topic_distribution: {},
    confidence_bucket_distribution: { high: 0, medium: 0, low: 0, unknown: 0 },
  }

  for (const row of rows) {
    const hasTopic = isPresent(row.category_slug)
    const hasFingerprint = [
      row.error_code,
      row.top_stack_frame,
      row.cli_version,
      row.fp_os,
      row.fp_shell,
      row.fp_editor,
      row.model_id,
    ].some(isPresent)
    const hasAnyLlm =
      isPresent(row.llm_category) ||
      isPresent(row.llm_subcategory) ||
      isPresent(row.llm_primary_tag)

    const cls = classificationFromRow(row)
    const bucket = cls.confidence_bucket
    const reviewFlagged = cls.review_flagged

    summary.confidence_bucket_distribution[bucket]++

    if (hasTopic) {
      summary.with_topic++
      const key = row.category_slug!.trim()
      summary.topic_distribution[key] = (summary.topic_distribution[key] ?? 0) + 1
    }
    if (hasFingerprint) summary.with_bug_fingerprint++

    if (hasAnyLlm) {
      summary.with_any_llm_classification++
      if (isPresent(row.llm_category)) {
        const key = row.llm_category!.trim()
        summary.llm_category_distribution[key] = (summary.llm_category_distribution[key] ?? 0) + 1
      }
      if (isPresent(row.llm_subcategory)) {
        const key = row.llm_subcategory!.trim()
        summary.llm_subcategory_distribution[key] =
          (summary.llm_subcategory_distribution[key] ?? 0) + 1
      }
    }

    if (bucket === "high") summary.with_high_confidence_llm_classification++
    if (reviewFlagged) summary.with_review_flagged_llm_classification++

    // Gate signal: same predicate the helper uses, applied through the
    // shared canUseTaxonomySignals so the metric can never drift from
    // the helper's runtime behavior.
    if (canUseTaxonomySignals(cls) && hasAnyLlm) summary.with_usable_taxonomy_triplet++

    const rawOnly =
      !hasTopic &&
      !hasFingerprint &&
      !(canUseTaxonomySignals(cls) && hasAnyLlm)
    if (rawOnly) summary.raw_only_fallback_count++
  }

  // Top-K the unbounded distribution maps before returning.
  summary.llm_category_distribution = topN(summary.llm_category_distribution)
  summary.llm_subcategory_distribution = topN(summary.llm_subcategory_distribution)
  summary.topic_distribution = topN(summary.topic_distribution)

  return summary
}

/** Per-observation preview for debugging: which fields the helper
 *  WOULD include vs. omit if we generated the embedding for this row.
 *  The omission reasons are deliberately specific so an operator
 *  scanning a sample can map "wait, why was Tags omitted on row X?"
 *  to a concrete explanation rather than guessing. */
export function buildCoveragePreview(
  rows: EmbeddingSignalCoverageRow[],
): EmbeddingSignalCoveragePreview[] {
  return rows.map((row) => {
    const included: string[] = ["title"]
    const omitted: string[] = []

    if (isPresent(row.content)) included.push("content")
    else omitted.push("content_missing")

    if (isPresent(row.category_slug)) included.push("topic")
    else omitted.push("topic_missing")

    if (
      [
        row.error_code,
        row.top_stack_frame,
        row.cli_version,
        row.fp_os,
        row.fp_shell,
        row.fp_editor,
        row.model_id,
      ].some(isPresent)
    ) {
      included.push("fingerprint")
    } else {
      omitted.push("fingerprint_missing")
    }

    const cls = classificationFromRow(row)
    const hasAnyLlm =
      isPresent(row.llm_category) ||
      isPresent(row.llm_subcategory) ||
      isPresent(row.llm_primary_tag)

    if (!hasAnyLlm) {
      omitted.push("llm_missing")
    } else if (cls.review_flagged) {
      // Check review-flagged BEFORE confidence, because a row with
      // both low confidence AND review-flagged should be reported as
      // "review_flagged" — that's the more actionable reason (a
      // reviewer explicitly rejected it; raising confidence won't help).
      omitted.push("llm_review_flagged")
    } else if (cls.confidence_bucket === "low" || cls.confidence_bucket === "unknown") {
      omitted.push("llm_low_confidence")
    } else {
      included.push("llm_taxonomy")
    }

    return { observation_id: row.observation_id, included_fields: included, omitted_reasons: omitted }
  })
}
