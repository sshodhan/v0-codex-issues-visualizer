/**
 * Production v3 embedding input assembler.
 *
 * Bridges the production embedding pipeline (`recomputeObservationEmbedding`
 * in `lib/storage/semantic-clusters.ts`) and the v3 helper
 * (`buildClassificationAwareEmbeddingText` in
 * `lib/embeddings/classification-aware-input.ts`).
 *
 * Phase 4 PR2 wires `recomputeObservationEmbedding` to call this
 * function when `CURRENT_VERSIONS.observation_embedding === "v3"`.
 * The fetcher reads from five upstream tables in parallel:
 *
 *   - `observations` / `observation_revisions`              — title + body
 *   - `category_assignments` -> `categories.slug`           — Topic
 *   - `bug_fingerprints`                                    — env + error + stack + repro_markers
 *   - `classifications` (latest by created_at)              — Tier 1 + Tier 2 LLM signals
 *   - `classification_reviews` (latest by reviewed_at)      — reviewer override + flag state
 *
 * All five lookups are best-effort: if any fails, the assembler logs
 * via `logServerError` and continues with partial data. The v3 helper
 * gracefully degrades — missing classification falls through
 * `canUseTaxonomySignals` to emit Tier 1 minus LLM taxonomy. This is
 * the same "best-effort with partial enrichment" pattern Phase 2's
 * coverage route established.
 *
 * Schema-source breadcrumbs are documented inline at each lookup so
 * the next reader doesn't have to rediscover the column→field
 * mapping (the lesson from PR #186's wrong-column `family_kind` bug).
 *
 * Reuses Phase 2's exported `helperInputFromRow` for the row→helper
 * input mapping. Single source of truth across:
 *   - Phase 2 coverage metric (admin-only)
 *   - Phase 2 preview output (admin-only)
 *   - Phase 4 production runtime (this file)
 */

import {
  buildClassificationAwareEmbeddingText,
  type ClassificationAwareEmbeddingInput,
} from "./classification-aware-input.ts"
import {
  helperInputFromRow,
  type EmbeddingSignalCoverageRow,
} from "./signal-coverage.ts"

// `AdminClient` is the runtime supabase client. Typed as any for test
// portability — the production wiring in lib/storage/semantic-clusters.ts
// passes a real `createAdminClient()` result; the node:test mocks pass
// a hand-built object with the same `.from(...).select(...)` shape. The
// real type is `ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>`
// but importing that here would break test module resolution under
// node:test --experimental-strip-types.
//
// The five `from()` calls below assume a fluent builder returning
// either `{ data, error: null }` or `{ data: null, error }` from
// `.maybeSingle()`. Both real PostgREST and the test mock satisfy that.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any

/** Status values from `classification_reviews.status` that count as
 *  "review-flagged". Same set Phase 2's admin route uses; centralizing
 *  here would create a cross-module import that doesn't exist today,
 *  so kept duplicated with a comment. If a reviewer state is added
 *  that should also gate the LLM output, update both:
 *    - app/api/admin/embedding-signal-coverage/route.ts
 *    - this file
 *  Or refactor to import from a shared lib/classification module. */
const FLAGGED_REVIEW_STATUSES = new Set([
  "flagged",
  "needs_review",
  "rejected",
  "incorrect",
  "invalid",
  "unclear",
])

/**
 * Assemble the v3 helper input for a single observation, then run the
 * v3 helper to produce the final embedding-text string.
 *
 * Returns the text (always — the helper degrades to Title-only when
 * everything else is missing) plus a debug summary of which side-table
 * lookups succeeded vs failed. The debug summary is logged into the
 * caller's `processing_events.detail_json` so an operator can answer
 * "why does this observation's v3 embedding look thin?" without
 * spelunking.
 */
export async function buildV3InputFromObservation(
  supabase: AdminClient,
  observation: { id: string; title: string; content?: string | null },
): Promise<{
  text: string
  helperInput: ClassificationAwareEmbeddingInput
  sideTableSummary: V3SideTableSummary
}> {
  const obsId = observation.id

  // Fetch the four side-tables in parallel. Each is best-effort.
  const [topicRes, fpRes, clsRes, reviewRes] = await Promise.all([
    // Topic: category_assignments -> categories.slug. Same lookup
    // pattern as the cluster route + the Phase 2 admin route.
    supabase
      .from("category_assignments")
      .select("category_id, categories!inner(slug)")
      .eq("observation_id", obsId)
      .order("assigned_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Bug fingerprint: one row per observation_id. The v3 helper
    // consumes error_code, top_stack_frame, cli_version, os, shell,
    // editor, model_id, repro_markers (count). Schema:
    // bug_fingerprints.repro_markers is `integer not null default 0`.
    supabase
      .from("bug_fingerprints")
      .select("error_code, top_stack_frame, cli_version, os, shell, editor, model_id, repro_markers")
      .eq("observation_id", obsId)
      .maybeSingle(),

    // Latest classification: ordered by created_at desc, take the
    // first row. classifications.confidence is numeric(3,2); the v3
    // helper's bucketConfidence handles both number and JSON-string
    // shapes, so we just pass it through.
    supabase
      .from("classifications")
      .select(
        "category, subcategory, primary_tag, severity, confidence, reproducibility, impact, tags, created_at",
      )
      .eq("observation_id", obsId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Latest review: ordered by reviewed_at desc, joined to
    // classifications via the inner FK so we filter to this
    // observation's reviews only. We take the freshest one.
    supabase
      .from("classification_reviews")
      .select(
        "category, subcategory, severity, status, needs_human_review, reviewed_at, classifications!inner(observation_id)",
      )
      .eq("classifications.observation_id", obsId)
      .order("reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const summary: V3SideTableSummary = {
    topic_lookup: topicRes.error ? "failed" : topicRes.data ? "found" : "not_found",
    fingerprint_lookup: fpRes.error ? "failed" : fpRes.data ? "found" : "not_found",
    classification_lookup: clsRes.error ? "failed" : clsRes.data ? "found" : "not_found",
    review_lookup: reviewRes.error ? "failed" : reviewRes.data ? "found" : "not_found",
  }

  // Best-effort logging. The v3 helper handles every "missing data"
  // case gracefully — an observation with no classification still
  // produces valid embedding text (Tier 1 raw + Topic + Environment).
  // Using console.error (matches lib/storage/derivations.ts pattern)
  // rather than logServerError so this module can be loaded under
  // node:test --experimental-strip-types without resolving @/ paths.
  if (topicRes.error) {
    console.error("[v3-input-from-observation] topic_lookup_failed:", obsId, topicRes.error)
  }
  if (fpRes.error) {
    console.error("[v3-input-from-observation] fingerprint_lookup_failed:", obsId, fpRes.error)
  }
  if (clsRes.error) {
    console.error("[v3-input-from-observation] classification_lookup_failed:", obsId, clsRes.error)
  }
  if (reviewRes.error) {
    console.error("[v3-input-from-observation] review_lookup_failed:", obsId, reviewRes.error)
  }

  // Resolve the Topic slug. PostgREST returns the embedded relationship
  // as either an object or array depending on join shape — handle both.
  const topicRel = topicRes.data?.categories as
    | { slug?: string | null }
    | Array<{ slug?: string | null }>
    | null
    | undefined
  const categorySlug = Array.isArray(topicRel)
    ? topicRel[0]?.slug ?? null
    : topicRel?.slug ?? null

  // Compute review-flagged: needs_human_review is the strong signal;
  // status is the secondary signal. Same logic as
  // app/api/admin/embedding-signal-coverage/route.ts.
  const reviewStatusLower = reviewRes.data?.status?.toLowerCase().trim() ?? ""
  const reviewFlagged =
    reviewRes.data?.needs_human_review === true || FLAGGED_REVIEW_STATUSES.has(reviewStatusLower)

  // Assemble the flat row in the shape the Phase 2 helperInputFromRow
  // expects. Reusing this mapping ensures the production runtime, the
  // Phase 2 admin metric, and the Phase 2 preview all derive the
  // helper input from the same flat-row contract.
  const row: EmbeddingSignalCoverageRow = {
    observation_id: obsId,
    title: observation.title,
    content: observation.content ?? null,
    category_slug: categorySlug,
    error_code: fpRes.data?.error_code ?? null,
    top_stack_frame: fpRes.data?.top_stack_frame ?? null,
    cli_version: fpRes.data?.cli_version ?? null,
    fp_os: fpRes.data?.os ?? null,
    fp_shell: fpRes.data?.shell ?? null,
    fp_editor: fpRes.data?.editor ?? null,
    model_id: fpRes.data?.model_id ?? null,
    repro_markers: fpRes.data?.repro_markers ?? null,
    llm_category: clsRes.data?.category ?? null,
    llm_subcategory: clsRes.data?.subcategory ?? null,
    llm_primary_tag: clsRes.data?.primary_tag ?? null,
    llm_severity: clsRes.data?.severity ?? null,
    llm_reproducibility: clsRes.data?.reproducibility ?? null,
    llm_impact: clsRes.data?.impact ?? null,
    llm_tags: clsRes.data?.tags ?? null,
    llm_confidence: clsRes.data?.confidence ?? null,
    review_flagged: reviewFlagged,
    reviewer_category: reviewRes.data?.category ?? null,
    reviewer_subcategory: reviewRes.data?.subcategory ?? null,
  }

  const helperInput = helperInputFromRow(row)
  const text = buildClassificationAwareEmbeddingText(helperInput)

  return { text, helperInput, sideTableSummary: summary }
}

/** Per-observation diagnostic of which v3 side-table lookups
 *  succeeded vs failed. Logged into `processing_events.detail_json`
 *  so an operator can answer "why is this v3 embedding thin?"
 *  without re-fetching from production. */
export interface V3SideTableSummary {
  topic_lookup: "found" | "not_found" | "failed"
  fingerprint_lookup: "found" | "not_found" | "failed"
  classification_lookup: "found" | "not_found" | "failed"
  review_lookup: "found" | "not_found" | "failed"
}
