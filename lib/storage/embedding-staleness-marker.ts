import { CURRENT_VERSIONS } from "./algorithm-versions.ts"

// `AdminClient` is the runtime supabase client. Typed as any for test
// portability — the production wiring in `derivations.ts` passes a
// real `createAdminClient()` result; the node:test mocks pass a
// hand-built object with the same `.from(...).select(...)` shape.
// The real type is `ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>`
// but importing that here would break test module resolution under
// node:test --experimental-strip-types.
//
// Same pattern we use in lib/embeddings/v3-input-from-observation.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any

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
 *
 * Lives in its own module (rather than inline in `derivations.ts`)
 * so node:test --experimental-strip-types can exercise it directly
 * without resolving `@/lib/...` aliases. The production caller
 * (`derivations.ts`) imports from here.
 */
export async function emitEmbeddingStaleMarkerIfNeeded(
  supabase: AdminClient,
  observationId: string,
  reason: "classification_updated" | "review_updated",
  triggerId?: string | null,
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
    console.error("[embedding-staleness-marker] lookup failed:", error)
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
  //
  // `algorithm_version_model` is left null. Convention is `<version>:<model>`
  // — the staleness event is not a model invocation, so a sentinel
  // string in the model slot would mis-attribute when downstream
  // tooling parses by `:`. The version this marker is gating on is
  // captured in `detail_json.embedding_algorithm_version`.
  //
  // `detail_json.trigger_id` carries the classification_id (or
  // classification_review_id) that caused the marker, so an operator
  // tracing "why was this obs marked stale?" can chain back to the
  // exact upstream write.
  const { error: insertError } = await supabase.from("processing_events").insert({
    observation_id: observationId,
    stage: "embedding",
    status: "stale",
    algorithm_version_model: null,
    detail_json: {
      reason,
      embedding_algorithm_version: CURRENT_VERSIONS.observation_embedding,
      trigger_id: triggerId ?? null,
      marked_at: new Date().toISOString(),
    },
  })

  if (insertError) {
    // Best-effort: a failed insert doesn't block the calling write.
    // The next rebuild without ?include_stale=true won't re-embed
    // this row, but operator-triggered manual re-embeds still work.
    console.error("[embedding-staleness-marker] insert failed:", insertError)
  }
}
