/**
 * Phase 1 v3 embedding text helper — reshaped in PR #194 for the
 * user-feedback corpus signal hierarchy (see "Corpus characteristics"
 * in docs/CLASSIFICATION_EVOLUTION_PLAN.md).
 *
 * ⚠️  NOT WIRED INTO PRODUCTION YET
 *
 * Production cluster rebuild calls `buildEmbeddingInputText` from
 * `lib/storage/semantic-cluster-core.ts` (the v2 builder), via
 * `ensureEmbedding` and `recomputeObservationEmbedding` in
 * `lib/storage/semantic-clusters.ts`. As of PR #194 merge, no production
 * code path imports this file. The complete list of importers is:
 *   - lib/embeddings/signal-coverage.ts (Phase 2 admin metric — read-only)
 *   - tests/classification-aware-input.test.ts
 *
 * Phase 4 PR2 will add a dispatch layer in `recomputeObservationEmbedding`
 * that calls this helper when `CURRENT_VERSIONS.observation_embedding`
 * is bumped to "v3". Until that PR lands, `git grep` for imports of this
 * module should return only the two files above. If you find a third
 * importer in `lib/storage/` or `app/api/`, the safety invariant of
 * PR #194 has been violated — please revert before any v3 rows can be
 * generated.
 */
export type ConfidenceBucket = "high" | "medium" | "low" | "unknown"

/** v3 algorithm signature — the numeric parameters that define what
 *  "v3" means in `observation_embeddings.algorithm_version`. Changing
 *  any value here implies a new algorithm version (v4): existing v3
 *  rows would no longer be reproducible from the new code, and the
 *  `algorithm_version` filter in `ensureEmbedding` would still match
 *  them as cache hits despite producing different text. Bump in
 *  lockstep with `lib/storage/algorithm-versions.ts` and a new
 *  migration script.
 *
 *  STRUCTURAL changes also require a version bump even when none of
 *  the numeric values here change. The structural properties of v3
 *  are pinned by `tests/classification-aware-input.test.ts`, not by
 *  this constant:
 *    - emit order (Tier 1 → Tier 2 → Tier 3)
 *    - Environment line collapse format and field order within it
 *      (`cli os shell editor model`)
 *    - confidence / review-flag gating policy (which fields are
 *      omitted under low-confidence vs review-flagged states)
 *    - tag normalization rules (trim → dedupe → ASCII sort)
 *    - the set of fields that are emitted at all
 *  If a test in that file is updated to reflect a new structural
 *  shape, that's a v4 signature change even if `V3_ALGORITHM_SIGNATURE`
 *  itself stays unchanged.
 *
 *  The Tier 1 / Tier 2 / Tier 3 hierarchy is documented in the plan
 *  doc's "Corpus characteristics" section and enforced by the emit
 *  order in `buildClassificationAwareEmbeddingText` below. The
 *  hierarchy is not encoded as data here because it's a structural
 *  property of the function, not a tunable parameter — re-tiering
 *  signals would also require renaming the function and rewriting
 *  tests, which is a stronger signal than a constant change. */
export const V3_ALGORITHM_SIGNATURE = Object.freeze({
  /** Body / Summary truncation cap. Matches Phase 1 v3 spec; chosen so
   *  the embedding model's context budget stays comfortably within
   *  text-embedding-3-small's 8192-token limit even with all structured
   *  signals present. */
  summary_max: 1200,
  /** Per-field truncation cap for label values (Category, Subcategory,
   *  Tag, etc). Prevents a runaway hallucinated string from dominating
   *  the embedding text. */
  field_value_max: 200,
  /** Top of the high-confidence band. `classifications.confidence` ≥
   *  this value → "high"; the helper emits gated taxonomy signals.
   *  Live distribution (verified 2026-05-01): 76.6% of rows are at or
   *  above this threshold. */
  confidence_high_min: 0.8,
  /** Top of the medium-confidence band. `classifications.confidence` ≥
   *  this value → "medium"; helper still emits gated taxonomy signals.
   *  Live distribution: 15.6% of rows are in [0.50, 0.80). */
  confidence_medium_min: 0.5,
  /** Repro-marker count threshold. `bug_fingerprints.repro_markers` ≥
   *  this value → emit `Repro markers: N`. Below this, the count is
   *  too noisy to discriminate (almost every report has 0 markers, so
   *  emitting "Repro markers: 0" for everyone would just pull all
   *  reports toward each other). */
  repro_marker_min: 2,
} as const)

const SUMMARY_MAX = V3_ALGORITHM_SIGNATURE.summary_max
const FIELD_VALUE_MAX = V3_ALGORITHM_SIGNATURE.field_value_max
const CONFIDENCE_BUCKET_HIGH_MIN = V3_ALGORITHM_SIGNATURE.confidence_high_min
const CONFIDENCE_BUCKET_MEDIUM_MIN = V3_ALGORITHM_SIGNATURE.confidence_medium_min
const REPRO_MARKER_MIN = V3_ALGORITHM_SIGNATURE.repro_marker_min

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

/** Build an `Environment: ...` line collapsing the supportive (Tier 3)
 *  fingerprint fields into one k=v string. Returns null when no field
 *  is populated (so the caller skips emitting the line entirely).
 *
 *  Why collapse: in a user-feedback corpus, fingerprint fields are
 *  sparse and mostly act as supporting context. Emitting each as a
 *  separate `CLI: …` / `OS: …` / `Editor: …` line creates seven
 *  literal-match anchors that can over-merge two unrelated reports
 *  sharing one environment value (e.g., both running `model=gpt-4o`).
 *  The collapsed form keeps the signal informative for the model
 *  without making any single field strong enough to dominate
 *  similarity scoring. See the plan's "Corpus characteristics" section.
 *
 *  Fields are emitted in fixed order (cli, os, shell, editor, model) so
 *  the produced string is byte-identical for byte-identical inputs —
 *  reproducibility is part of the v3 algorithm signature. */
function buildEnvironmentLine(
  fp: ClassificationAwareEmbeddingInput["bugFingerprint"],
): string | null {
  if (!fp) return null
  const parts: string[] = []
  const push = (key: string, value?: string | null) => {
    const trimmed = value?.trim()
    if (!trimmed) return
    if (trimmed.toLowerCase() === "unknown") return
    parts.push(`${key}=${trimmed.slice(0, FIELD_VALUE_MAX)}`)
  }
  push("cli", fp.cli_version)
  push("os", fp.os)
  push("shell", fp.shell)
  push("editor", fp.editor)
  push("model", fp.model_id)
  return parts.length > 0 ? `Environment: ${parts.join(" ")}` : null
}

/** v3 embedding text builder, tier-ordered for a user-feedback corpus.
 *
 *  Emit order is fixed and corresponds to the signal-value hierarchy
 *  documented in the plan doc's "Corpus characteristics" section:
 *
 *    Tier 1 (primary)    — Title, Summary, Topic, LLM Category /
 *                           Subcategory / Tags (gated)
 *    Tier 2 (secondary)  — Severity, Reproducibility, Impact, Confidence
 *    Tier 3 (supportive) — Environment (collapsed), Error, Stack,
 *                           Repro markers
 *
 *  This order is also the test contract — `tests/classification-aware-input.test.ts`
 *  pins it. Reordering fields here without also re-running and updating
 *  the test that asserts the order is a v3 algorithm-signature change
 *  and requires a new algorithm version. */
export function buildClassificationAwareEmbeddingText(input: ClassificationAwareEmbeddingInput): string {
  const lines: string[] = []

  // ---- Tier 1: primary signals ----
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

  // ---- Tier 2: secondary signals (gated on review-flagged only) ----
  // Two failure modes Tier 2 must protect against:
  //
  //   1. Low overall classification confidence. The original Phase 1
  //      design intentionally lets these scalars through even at low
  //      confidence: severity/impact/repro are short scalar enums
  //      where the model treats `high` / `low` / `unknown` as honest
  //      signals about the *report*. Even when overall confidence is
  //      low, the LLM's per-axis self-rating is useful self-anchoring
  //      data. The taxonomy gate (`canUseTaxonomySignals`) protects
  //      against false-positive *grouping* on hallucinated
  //      category/tag strings — a different failure mode than a
  //      single severity enum. The `pushIfPresent` "unknown" filter
  //      already prevents the most-common low-confidence noise.
  //
  //   2. Review-flagged classifications. Stronger signal than low
  //      confidence: a human reviewer explicitly rejected the LLM
  //      output. Trusting the LLM's severity/impact/repro values
  //      while gating out its category/subcategory/tags is
  //      inconsistent — both come from the same LLM call the
  //      reviewer just rejected. So Tier 2 scalars are gated on
  //      review_flagged.
  //
  // Net effect:
  //   low-confidence + not-flagged → emit (existing rationale holds)
  //   review-flagged                → omit (reviewer veto trumps)
  if (!cls?.review_flagged) {
    pushIfPresent(lines, "Severity", cls?.severity)
    pushIfPresent(lines, "Reproducibility", cls?.reproducibility)
    pushIfPresent(lines, "Impact", cls?.impact)
    pushIfPresent(lines, "Confidence", cls?.confidence_bucket)
  }

  // ---- Tier 3: supportive context (collapsed; emit last) ----
  const fp = input.bugFingerprint
  const envLine = buildEnvironmentLine(fp)
  if (envLine) lines.push(envLine)

  // Error code and top stack frame are conceptually distinct from the
  // collapsed Environment line — they describe the *failure*, not the
  // *runtime context*. Emit each on its own line when present, but
  // place them after the Environment line so high-value Tier 1/2
  // signals are positioned earlier in the prompt.
  pushIfPresent(lines, "Error", fp?.error_code)
  pushIfPresent(lines, "Stack", fp?.top_stack_frame)

  // Repro marker count: emit only when it's high enough to discriminate
  // (≥ REPRO_MARKER_MIN). A bug with 0 or 1 marker carries no grouping
  // signal — almost every report has 0, so embedding `Repro markers: 0`
  // for everyone would just pull all reports toward each other.
  const reproCount = fp?.repro_markers
  if (typeof reproCount === "number" && reproCount >= REPRO_MARKER_MIN) {
    lines.push(`Repro markers: ${reproCount}`)
  }

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
