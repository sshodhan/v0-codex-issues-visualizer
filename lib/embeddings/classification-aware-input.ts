export type ConfidenceBucket = "high" | "medium" | "low" | "unknown"

export interface ClassificationAwareEmbeddingInput {
  title: string
  body?: string | null
  topic?: string | null
  bugFingerprint?: {
    error_code?: string | null
    top_stack_frame?: string | null
    cli_version?: string | null
    os?: string | null
    shell?: string | null
    editor?: string | null
    model_id?: string | null
    repro_markers?: string[] | null
  } | null
  classification?: {
    category?: string | null
    subcategory?: string | null
    tags?: string[] | null
    severity?: string | null
    confidence_bucket?: ConfidenceBucket | null
    reproducibility?: string | null
    impact?: string | null
    evidence_quotes?: string[] | null
    review_flagged?: boolean | null
    reviewer_category?: string | null
    reviewer_subcategory?: string | null
  } | null
}

function pushIfPresent(lines: string[], label: string, value?: string | null): void {
  const trimmed = value?.trim()
  if (trimmed) lines.push(`${label}: ${trimmed}`)
}

function normalizeTags(tags?: string[] | null): string[] {
  if (!tags) return []
  const cleaned = tags.map((t) => t.trim()).filter(Boolean)
  return [...new Set(cleaned)].sort((a, b) => a.localeCompare(b))
}

function canUseTaxonomySignals(classification?: ClassificationAwareEmbeddingInput["classification"] | null): boolean {
  if (!classification) return false
  if (classification.review_flagged) return false
  return classification.confidence_bucket === "high" || classification.confidence_bucket === "medium"
}

export function buildClassificationAwareEmbeddingText(input: ClassificationAwareEmbeddingInput): string {
  const lines: string[] = []

  // Raw text is always present.
  lines.push(`Title: ${input.title.trim()}`)
  const body = input.body?.trim()
  if (body) lines.push(`Summary: ${body}`)

  pushIfPresent(lines, "Topic", input.topic)

  const fp = input.bugFingerprint
  pushIfPresent(lines, "Error", fp?.error_code)
  pushIfPresent(lines, "Stack", fp?.top_stack_frame)
  pushIfPresent(lines, "CLI", fp?.cli_version)
  pushIfPresent(lines, "OS", fp?.os)
  pushIfPresent(lines, "Shell", fp?.shell)
  pushIfPresent(lines, "Editor", fp?.editor)
  pushIfPresent(lines, "Model", fp?.model_id)

  const repro = fp?.repro_markers?.map((m) => m.trim()).filter(Boolean)
  if (repro && repro.length > 0) lines.push(`Repro markers: ${repro.join(", ")}`)

  const cls = input.classification
  if (canUseTaxonomySignals(cls)) {
    const effectiveCategory = cls?.reviewer_category?.trim() || cls?.category?.trim() || null
    const effectiveSubcategory = cls?.reviewer_subcategory?.trim() || cls?.subcategory?.trim() || null
    pushIfPresent(lines, "Category", effectiveCategory)
    pushIfPresent(lines, "Subcategory", effectiveSubcategory)

    const tags = normalizeTags(cls?.tags)
    if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`)
  }

  pushIfPresent(lines, "Severity", cls?.severity)
  pushIfPresent(lines, "Confidence", cls?.confidence_bucket)
  pushIfPresent(lines, "Reproducibility", cls?.reproducibility)
  pushIfPresent(lines, "Impact", cls?.impact)

  return lines.join("\n")
}
