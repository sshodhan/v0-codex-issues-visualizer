import {
  bucketConfidence,
  buildClassificationAwareEmbeddingText,
  buildRawEmbeddingText,
  canUseTaxonomySignals,
  type ClassificationAwareEmbeddingInput,
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
  llm_severity?: string | null
  llm_reproducibility?: string | null
  llm_impact?: string | null
  /** `classifications.confidence` is `numeric(3,2)` returned as either
   *  number (server-side) or JSON string (PostgREST client). */
  llm_confidence?: number | string | null
  /** Optional list of LLM-emitted tags (`classifications.tags`, text[]). */
  llm_tags?: string[] | null
  /** Resolved by the caller from `classification_reviews`
   *  (needs_human_review = true OR status in {flagged, rejected,
   *  needs_review, incorrect, invalid, ...}). */
  review_flagged?: boolean | null
  /** Reviewer-corrected category/subcategory, when a review row exists. */
  reviewer_category?: string | null
  reviewer_subcategory?: string | null
}

export interface EmbeddingSignalCoveragePreview {
  observation_id: string
  /** Baseline embedding text — title + summary only. The "without v3"
   *  comparison point requested by the Phase 2 preview spec. */
  raw_embedding_text: string
  /** Full v3 embedding text, exactly what `buildClassificationAwareEmbeddingText`
   *  would produce for this row given the gating rules. */
  classification_embedding_text: string
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
  /** Derived percentages for the Phase 2 decision gate. These are the
   *  numbers an operator looks at to answer "should we proceed to
   *  Phase 4?" — surfacing them precomputed avoids manual calculation
   *  and ensures every consumer of this endpoint reads the same
   *  ratios. All values are 0..1 (multiply by 100 for display). null
   *  when total_observations is 0 (avoids divide-by-zero NaN). */
  percentages: {
    usable_taxonomy_pct: number | null
    raw_only_pct: number | null
    review_flagged_pct: number | null
    high_confidence_pct: number | null
    medium_confidence_pct: number | null
    low_confidence_pct: number | null
    /** Share of observations with ANY structured-signal field
     *  populated (Topic OR fingerprint OR usable taxonomy). Rough
     *  proxy for "how often will v3 produce more than raw-only?". */
    any_structured_signal_pct: number | null
  }
}

const TOP_K_DISTRIBUTION = 20

function isPresent(v?: string | null): boolean {
  return Boolean(v && v.trim())
}

/** Round a ratio to 4 decimal places (basis-point precision). Returns
 *  null when denominator is zero so callers can render "—" instead of
 *  the misleading 0%. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Number((numerator / denominator).toFixed(4))
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

/** Assemble the helper-input shape from a flat database row. Used by:
 *  - the Phase 2 metric (to evaluate `canUseTaxonomySignals` consistently),
 *  - the Phase 2 preview (to label omission reasons + render the actual v3
 *    string),
 *  - the Phase 4 production embedding pipeline (to feed the v3 helper
 *    when `CURRENT_VERSIONS.observation_embedding === "v3"`).
 *
 *  Centralizing this is what keeps the metric, the preview, and the
 *  runtime in sync — every consumer turns a flat DB row into a
 *  `ClassificationAwareEmbeddingInput` through this single function.
 *  Exported (not just internal) so Phase 4 PR2's wiring change in
 *  `lib/storage/semantic-clusters.ts` can reuse the same mapping
 *  without duplicating the field list. */
export function helperInputFromRow(row: EmbeddingSignalCoverageRow): ClassificationAwareEmbeddingInput {
  const bucket = bucketConfidence(row.llm_confidence)
  return {
    title: row.title ?? "",
    body: row.content ?? null,
    topic: row.category_slug ?? null,
    bugFingerprint: {
      error_code: row.error_code ?? null,
      top_stack_frame: row.top_stack_frame ?? null,
      cli_version: row.cli_version ?? null,
      os: row.fp_os ?? null,
      shell: row.fp_shell ?? null,
      editor: row.fp_editor ?? null,
      model_id: row.model_id ?? null,
      repro_markers: row.repro_markers ?? null,
    },
    classification: {
      category: row.llm_category ?? null,
      subcategory: row.llm_subcategory ?? null,
      tags: row.llm_tags ?? null,
      severity: row.llm_severity ?? null,
      reproducibility: row.llm_reproducibility ?? null,
      impact: row.llm_impact ?? null,
      confidence_bucket: bucket,
      review_flagged: Boolean(row.review_flagged),
      reviewer_category: row.reviewer_category ?? null,
      reviewer_subcategory: row.reviewer_subcategory ?? null,
    },
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
    percentages: {
      usable_taxonomy_pct: null,
      raw_only_pct: null,
      review_flagged_pct: null,
      high_confidence_pct: null,
      medium_confidence_pct: null,
      low_confidence_pct: null,
      any_structured_signal_pct: null,
    },
  }

  let withAnyStructuredSignal = 0

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

    const helperInput = helperInputFromRow(row)
    const cls = helperInput.classification!
    const bucket = cls.confidence_bucket as ConfidenceBucket
    const reviewFlagged = cls.review_flagged === true

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

    const usable = canUseTaxonomySignals(cls) && hasAnyLlm
    if (usable) summary.with_usable_taxonomy_triplet++

    const rawOnly = !hasTopic && !hasFingerprint && !usable
    if (rawOnly) summary.raw_only_fallback_count++
    else withAnyStructuredSignal++
  }

  // Top-K the unbounded distribution maps before returning.
  summary.llm_category_distribution = topN(summary.llm_category_distribution)
  summary.llm_subcategory_distribution = topN(summary.llm_subcategory_distribution)
  summary.topic_distribution = topN(summary.topic_distribution)

  // Derived ratios for the Phase 2 decision gate.
  const total = summary.total_observations
  summary.percentages = {
    usable_taxonomy_pct: ratio(summary.with_usable_taxonomy_triplet, total),
    raw_only_pct: ratio(summary.raw_only_fallback_count, total),
    review_flagged_pct: ratio(summary.with_review_flagged_llm_classification, total),
    high_confidence_pct: ratio(summary.confidence_bucket_distribution.high, total),
    medium_confidence_pct: ratio(summary.confidence_bucket_distribution.medium, total),
    low_confidence_pct: ratio(summary.confidence_bucket_distribution.low, total),
    any_structured_signal_pct: ratio(withAnyStructuredSignal, total),
  }

  return summary
}

/** Per-observation preview for debugging. The Phase 2 plan's optional
 *  preview asks for raw embedding text, classification-aware embedding
 *  text, included fields, and omitted fields with reasons — all four
 *  appear here so an operator can verify "would Phase 4 actually
 *  improve this row's embedding?" without round-tripping through SQL. */
export function buildCoveragePreview(
  rows: EmbeddingSignalCoverageRow[],
): EmbeddingSignalCoveragePreview[] {
  return rows.map((row) => {
    const helperInput = helperInputFromRow(row)
    const raw_embedding_text = buildRawEmbeddingText(helperInput.title, helperInput.body)
    const classification_embedding_text = buildClassificationAwareEmbeddingText(helperInput)

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

    const cls = helperInput.classification!
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

    return {
      observation_id: row.observation_id,
      raw_embedding_text,
      classification_embedding_text,
      included_fields: included,
      omitted_reasons: omitted,
    }
  })
}
