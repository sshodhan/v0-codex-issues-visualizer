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

  // Raw text is always present.
  lines.push(`Title: ${input.title.trim()}`)
  const body = input.body?.trim()
  if (body) lines.push(`Summary: ${body.slice(0, SUMMARY_MAX)}`)

  pushIfPresent(lines, "Topic", input.topic)

  const fp = input.bugFingerprint
  pushIfPresent(lines, "Error", fp?.error_code)
  pushIfPresent(lines, "Stack", fp?.top_stack_frame)
  pushIfPresent(lines, "CLI", fp?.cli_version)
  pushIfPresent(lines, "OS", fp?.os)
  pushIfPresent(lines, "Shell", fp?.shell)
  pushIfPresent(lines, "Editor", fp?.editor)
  pushIfPresent(lines, "Model", fp?.model_id)

  // Repro marker count: emit only when it's high enough to discriminate
  // (≥ 2). A bug with 0 or 1 marker carries no grouping signal — almost
  // every report has 0, so embedding `Repro markers: 0` for everyone
  // would just pull all reports toward each other.
  const reproCount = fp?.repro_markers
  if (typeof reproCount === "number" && reproCount >= 2) {
    lines.push(`Repro markers: ${reproCount}`)
  }

  const cls = input.classification
  if (canUseTaxonomySignals(cls)) {
    const effectiveCategory = cls?.reviewer_category?.trim() || cls?.category?.trim() || null
    const effectiveSubcategory = cls?.reviewer_subcategory?.trim() || cls?.subcategory?.trim() || null
    pushIfPresent(lines, "Category", effectiveCategory?.slice(0, FIELD_VALUE_MAX))
    pushIfPresent(lines, "Subcategory", effectiveSubcategory?.slice(0, FIELD_VALUE_MAX))

    const tags = normalizeTags(cls?.tags)
    if (tags.length > 0) lines.push(`Tags: ${tags.map((t) => t.slice(0, FIELD_VALUE_MAX)).join(", ")}`)
  }

  // Severity / Confidence / Reproducibility / Impact intentionally
  // bypass `canUseTaxonomySignals`. Rationale: severity/impact/repro
  // are short scalar enums where the model treats `high` / `low` /
  // `unknown` as honest signals about the *report*; even at low
  // overall classification confidence, knowing the LLM rated the
  // severity as "high" is useful self-anchoring data. The taxonomy
  // gate exists to protect against false-positive *grouping* on
  // hallucinated category/tag strings — a different failure mode than
  // a single severity enum. The `pushIfPresent` "unknown" filter
  // already prevents the most-common low-confidence noise.
  pushIfPresent(lines, "Severity", cls?.severity)
  pushIfPresent(lines, "Confidence", cls?.confidence_bucket)
  pushIfPresent(lines, "Reproducibility", cls?.reproducibility)
  pushIfPresent(lines, "Impact", cls?.impact)

  return lines.join("\n")
}
