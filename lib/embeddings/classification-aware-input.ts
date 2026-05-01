export type ConfidenceBucket = "high" | "medium" | "low" | "unknown"
const SUMMARY_MAX = 1200
const FIELD_VALUE_MAX = 200

/** Numeric thresholds for the confidence bucket. The thresholds are
 *  calibrated against the live `classifications.confidence` distribution
 *  (verified 2026-05-01: 76.6% ≥ 0.80, 15.6% in [0.50, 0.80), 7.8% < 0.50
 *  across 77 classifications) — none of the buckets are degenerate. If
 *  the production distribution shifts materially these can be re-tuned
 *  in one place. */
const CONFIDENCE_BUCKET_HIGH_MIN = 0.8
const CONFIDENCE_BUCKET_MEDIUM_MIN = 0.5

function stableAsciiSort(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Map `classifications.confidence` (a `numeric(3,2)` returned by
 *  PostgREST as either a JS number OR a JSON string like "0.80") into
 *  the categorical bucket the embedding gate uses. Centralizing this in
 *  one place is what prevents the metric and the helper from drifting:
 *  every call site converts numeric → bucket through this function and
 *  compares against the same enum. */
export function bucketConfidence(score: number | string | null | undefined): ConfidenceBucket {
  if (score == null) return "unknown"
  const n = typeof score === "number" ? score : Number(score)
  if (!Number.isFinite(n)) return "unknown"
  if (n >= CONFIDENCE_BUCKET_HIGH_MIN) return "high"
  if (n >= CONFIDENCE_BUCKET_MEDIUM_MIN) return "medium"
  return "low"
}

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
    /** `bug_fingerprints.repro_markers` is `integer not null default 0`
     *  in the production schema — a count, not a marker list. We keep
     *  it as a number here and only emit it when it carries enough
     *  signal to be worth anchoring on (≥ 2). When the schema later
     *  exposes individual marker labels (e.g., as `text[]`), this
     *  field can switch shape. */
    repro_markers?: number | null
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
  if (!trimmed) return
  // Avoid inventing placeholder semantics in embedding text — observed
  // in production data: "unknown" appears as a sentinel for fields the
  // upstream stage couldn't determine, and embedding it pulls unrelated
  // observations together via that shared sentinel.
  if (trimmed.toLowerCase() === "unknown") return
  lines.push(`${label}: ${trimmed}`)
}

function normalizeTags(tags?: string[] | null): string[] {
  if (!tags) return []
  const cleaned = tags.map((t) => t.trim()).filter(Boolean)
  return [...new Set(cleaned)].sort(stableAsciiSort)
}

/** Single source of truth for "should the LLM-derived taxonomy
 *  (Category / Subcategory / Tags) appear in the embedding text?".
 *  Exported because the Phase 2 signal-coverage metric MUST use the
 *  same gate — if the metric reports "70% usable" but the helper
 *  embeds 50% of those, the Phase 4 decision is calibrated against the
 *  wrong number. See `summarizeEmbeddingSignalCoverage` and the
 *  CLASSIFICATION_EVOLUTION_PLAN.md Phase 2 decision gate. */
export function canUseTaxonomySignals(
  classification?: ClassificationAwareEmbeddingInput["classification"] | null,
): boolean {
  if (!classification) return false
  if (classification.review_flagged) return false
  return classification.confidence_bucket === "high" || classification.confidence_bucket === "medium"
}

export function buildClassificationAwareEmbeddingText(input: ClassificationAwareEmbeddingInput): string {
  const lines: string[] = []

  // Tier 1 — raw text is always present.
  lines.push(`Title: ${input.title.trim()}`)
  const body = input.body?.trim()
  if (body) lines.push(`Summary: ${body.slice(0, SUMMARY_MAX)}`)

  pushIfPresent(lines, "Topic", input.topic)

  const cls = input.classification
  if (canUseTaxonomySignals(cls)) {
    const effectiveCategory = cls?.reviewer_category?.trim() || cls?.category?.trim() || null
    const effectiveSubcategory = cls?.reviewer_subcategory?.trim() || cls?.subcategory?.trim() || null
    pushIfPresent(lines, "Category", effectiveCategory?.slice(0, FIELD_VALUE_MAX))
    pushIfPresent(lines, "Subcategory", effectiveSubcategory?.slice(0, FIELD_VALUE_MAX))

    const tags = normalizeTags(cls?.tags)
    if (tags.length > 0) lines.push(`Tags: ${tags.map((t) => t.slice(0, FIELD_VALUE_MAX)).join(", ")}`)
  }

  // Tier 2 — scalar classification fields remain valuable even when
  // taxonomy strings are gated out.
  pushIfPresent(lines, "Severity", cls?.severity)
  pushIfPresent(lines, "Confidence", cls?.confidence_bucket)
  pushIfPresent(lines, "Reproducibility", cls?.reproducibility)
  pushIfPresent(lines, "Impact", cls?.impact)

  // Tier 3 — collapse environment fingerprint into one line so sparse
  // literal environment values don't over-anchor unrelated reports.
  const fp = input.bugFingerprint
  const envParts: string[] = []
  const cli = fp?.cli_version?.trim()
  if (cli && cli.toLowerCase() !== "unknown") envParts.push(`cli=${cli}`)
  const os = fp?.os?.trim()
  if (os && os.toLowerCase() !== "unknown") envParts.push(`os=${os}`)
  const shell = fp?.shell?.trim()
  if (shell && shell.toLowerCase() !== "unknown") envParts.push(`shell=${shell}`)
  const editor = fp?.editor?.trim()
  if (editor && editor.toLowerCase() !== "unknown") envParts.push(`editor=${editor}`)
  const model = fp?.model_id?.trim()
  if (model && model.toLowerCase() !== "unknown") envParts.push(`model=${model}`)
  if (envParts.length > 0) lines.push(`Environment: ${envParts.join(" ")}`)

  pushIfPresent(lines, "Error", fp?.error_code)
  pushIfPresent(lines, "Stack", fp?.top_stack_frame)

  const reproCount = fp?.repro_markers
  if (typeof reproCount === "number" && reproCount >= 2) lines.push(`Repro markers: ${reproCount}`)

  return lines.join("\n")
}

/** Baseline "raw" embedding input — title + summary only, with the
 *  same body-truncation rule as the classification-aware variant.
 *  Used by the Phase 2 preview to surface what an embedding would
 *  contain WITHOUT any of v3's structured signals, so an operator
 *  comparing the two sees the actual delta v3 contributes. The
 *  Phase 2 plan's preview spec calls for both strings side by side. */
export function buildRawEmbeddingText(title: string, body?: string | null): string {
  const lines: string[] = [`Title: ${title.trim()}`]
  const trimmedBody = body?.trim()
  if (trimmedBody) lines.push(`Summary: ${trimmedBody.slice(0, SUMMARY_MAX)}`)
  return lines.join("\n")
}
