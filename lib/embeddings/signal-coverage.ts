export interface EmbeddingSignalCoverageRow {
  observation_id: string
  category_slug?: string | null
  error_code?: string | null
  top_stack_frame?: string | null
  cli_version?: string | null
  fp_os?: string | null
  fp_shell?: string | null
  fp_editor?: string | null
  model_id?: string | null
  llm_category?: string | null
  llm_subcategory?: string | null
  llm_primary_tag?: string | null
  llm_confidence?: string | null
  llm_review_status?: string | null
}

export interface EmbeddingSignalCoverageSummary {
  total_observations: number
  with_topic: number
  with_bug_fingerprint: number
  with_any_llm_classification: number
  with_high_confidence_llm_classification: number
  with_review_flagged_llm_classification: number
  with_usable_taxonomy_triplet: number
  raw_only_fallback_count: number
  llm_category_distribution: Record<string, number>
  llm_subcategory_distribution: Record<string, number>
  topic_distribution: Record<string, number>
}

const HIGH_CONFIDENCE_VALUES = new Set(["high", "high_confidence"])
const FLAGGED_REVIEW_VALUES = new Set(["flagged", "needs_review", "rejected"])

function isPresent(v?: string | null): boolean {
  return Boolean(v && v.trim())
}

export function summarizeEmbeddingSignalCoverage(rows: EmbeddingSignalCoverageRow[]): EmbeddingSignalCoverageSummary {
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
    const hasAnyLlm = isPresent(row.llm_category) || isPresent(row.llm_subcategory) || isPresent(row.llm_primary_tag)
    const confidence = (row.llm_confidence ?? "").trim().toLowerCase()
    const reviewStatus = (row.llm_review_status ?? "").trim().toLowerCase()
    const highConfidence = HIGH_CONFIDENCE_VALUES.has(confidence)
    const reviewFlagged = FLAGGED_REVIEW_VALUES.has(reviewStatus)
    const usableTaxonomyTriplet = !reviewFlagged && highConfidence && (isPresent(row.llm_category) || isPresent(row.llm_subcategory) || isPresent(row.llm_primary_tag))

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
        summary.llm_subcategory_distribution[key] = (summary.llm_subcategory_distribution[key] ?? 0) + 1
      }
    }
    if (highConfidence) summary.with_high_confidence_llm_classification++
    if (reviewFlagged) summary.with_review_flagged_llm_classification++
    if (usableTaxonomyTriplet) summary.with_usable_taxonomy_triplet++

    const rawOnly = !hasTopic && !hasFingerprint && !usableTaxonomyTriplet
    if (rawOnly) summary.raw_only_fallback_count++
  }

  return summary
}
