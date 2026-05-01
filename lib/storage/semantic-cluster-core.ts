export interface SemanticObservationInput {
  id: string
  title: string
  content?: string | null
  // Optional Topic / fingerprint context, used by both:
  //   1. the deterministic fallback labeller when the LLM call fails or
  //      returns low confidence (lib/storage/cluster-label-fallback.ts), and
  //   2. v2+ embedding input construction (semantic-cluster-core
  //      buildEmbeddingInputText), which prepends bracketed structured
  //      signals to anchor the embedding in issue type rather than
  //      surface prose. See scripts/034_observation_embedding_v2_bump.sql.
  // Callers that don't have these signals (legacy providers, ad-hoc
  // recomputes) may safely omit them — embedding falls back to the
  // v1-equivalent prose-only input.
  topicSlug?: string | null
  errorCode?: string | null
  /** Stage-4 family_kind (e.g. "bug" / "feature_request"). Strongest
   *  type signal we have when populated; null until the cluster has
   *  been family-classified. */
  familyKind?: string | null
  /** bug_fingerprints.top_stack_frame, used as a within-error
   *  discriminator (e.g. two TIMEOUTs from different code paths). */
  topStackFrame?: string | null
  /** bug_fingerprints.os ("windows" / "macos" / "linux"). */
  platform?: string | null
}

export interface EmbeddedObservation extends SemanticObservationInput {
  embedding: number[]
}

export interface SemanticGroupingResult {
  semanticGroups: EmbeddedObservation[][]
  fallbackObservationIds: string[]
  /** Histogram of pairwise cosine similarities, bucketed for threshold
   *  tuning. Keys are bucket lower-bounds (0.0, 0.5, 0.6, 0.7, 0.75, 0.8,
   *  0.83, 0.86, 0.9, 0.95). Pairs with `sim < 0` (zero-norm vectors) are
   *  counted in the `invalid` field. Total pair count = n*(n-1)/2 + invalid. */
  similarityHistogram: {
    buckets: Record<string, number>
    invalid: number
    totalPairs: number
  }
}

/** Bucket lower-bounds for the pairwise similarity histogram. The wider
 *  high-end buckets (0.83, 0.86, 0.9) are deliberately tighter because
 *  threshold tuning happens in that range. Calibrated for cosine
 *  similarity of `text-embedding-3-small` outputs (1536d, normalized);
 *  switching embedding models invalidates these boundaries — re-tune
 *  if/when that happens. */
export const HISTOGRAM_BUCKETS = [0.0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.83, 0.86, 0.9, 0.95] as const

/** Map a cosine similarity in [-1, 1] to the bucket key it belongs to.
 *  Bucket key is the lower-bound formatted to 2dp (e.g. "0.86"). Values
 *  >= the largest bucket land in the largest bucket; values below 0.0
 *  also land in the smallest bucket since the histogram only tracks
 *  non-negative similarities (callers count `< 0` as `invalid`). */
export function bucketKeyFor(sim: number): string {
  for (let i = HISTOGRAM_BUCKETS.length - 1; i >= 0; i--) {
    if (sim >= HISTOGRAM_BUCKETS[i]) return HISTOGRAM_BUCKETS[i].toFixed(2)
  }
  return HISTOGRAM_BUCKETS[0].toFixed(2)
}

function norm(vector: number[]): number {
  let sum = 0
  for (const v of vector) sum += v * v
  return Math.sqrt(sum)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  const denom = norm(a) * norm(b)
  if (!Number.isFinite(denom) || denom === 0) return -1
  return dot / denom
}

/** Inclusive nearest-rank percentile over a numeric array. Returns null
 *  for empty input so callers can render "—" instead of NaN. Lives here
 *  (not in semantic-clusters.ts) because this module has no @/lib alias
 *  imports — keeping it co-located makes the helper unit-testable from
 *  node:test without a bundler. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/** Optional structured signals prepended to the embedding input as
 *  bracketed tags. Each is omitted when null/empty, so v2 gracefully
 *  degrades to v1's prose-only behavior for observations lacking
 *  structured context. Order is fixed so the produced string is
 *  byte-identical for byte-identical inputs (deterministic embeddings).
 *
 *  See scripts/034_observation_embedding_v2_bump.sql for the rationale
 *  — the surface-prose-only v1 input was the root cause of the
 *  singleton-cluster pathology in production. */
export interface EmbeddingStructuredSignals {
  /** family_kind from Stage-4 family_classification. e.g. "bug",
   *  "feature_request", "question". */
  type?: string | null
  /** error_code from bug_fingerprints. e.g. "TIMEOUT", "EACCES". */
  errorCode?: string | null
  /** Heuristic category slug from category_assignments. e.g. "ux-ui",
   *  "performance". Coarser than family_kind but populated for nearly
   *  all rows. */
  component?: string | null
  /** top_stack_frame from bug_fingerprints. Truncated to TOP_STACK_FRAME_MAX
   *  chars to keep the prefix bounded. */
  topStackFrame?: string | null
  /** os from bug_fingerprints. e.g. "windows", "macos". */
  platform?: string | null
}

const TOP_STACK_FRAME_MAX = 60

/** v2 embedding input: bracketed structured signals (when present)
 *  followed by the original `Title: …\nSummary: …` block. The model
 *  sees "what kind of issue is this?" before it sees the prose
 *  description, which empirically grounds the embedding in issue type
 *  rather than vocabulary.
 *
 *  v1 (signals all null/undefined) collapses to the original
 *  prose-only output, so behavior is unchanged for callers that don't
 *  pass structured context. */
export function buildEmbeddingInputText(
  title: string,
  content?: string | null,
  signals?: EmbeddingStructuredSignals,
): string {
  const tags: string[] = []
  // Render order is fixed: most-discriminating signals first so they
  // anchor the embedding even when later prose dominates token count.
  const t = signals?.type?.trim()
  if (t) tags.push(`[Type: ${t}]`)
  const ec = signals?.errorCode?.trim()
  if (ec) tags.push(`[Error: ${ec}]`)
  const comp = signals?.component?.trim()
  if (comp) tags.push(`[Component: ${comp}]`)
  const stack = signals?.topStackFrame?.trim()
  if (stack) tags.push(`[Stack: ${stack.slice(0, TOP_STACK_FRAME_MAX)}]`)
  const plat = signals?.platform?.trim()
  if (plat) tags.push(`[Platform: ${plat}]`)

  const prefix = tags.length > 0 ? `${tags.join(" ")}\n` : ""

  if (content && content.trim()) {
    const summary = content.trim().slice(0, 1200)
    return `${prefix}Title: ${title.trim()}\nSummary: ${summary}`
  }
  return `${prefix}Title: ${title.trim()}`
}

export function clusterEmbeddings(
  observations: EmbeddedObservation[],
  similarityThreshold: number,
  minClusterSize: number,
): SemanticGroupingResult {
  const visited = new Set<string>()
  const semanticGroups: EmbeddedObservation[][] = []
  const fallbackObservationIds: string[] = []

  const adjacency = new Map<string, Set<string>>()
  for (const obs of observations) adjacency.set(obs.id, new Set())

  // Histogram counters — one per bucket plus `invalid` for sim < 0
  // (zero-norm vectors, mismatched dims). Initialized at zero across all
  // buckets so callers can render a stable shape even when no pairs exist.
  const buckets: Record<string, number> = {}
  for (const lo of HISTOGRAM_BUCKETS) buckets[lo.toFixed(2)] = 0
  let invalid = 0
  let totalPairs = 0

  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      const sim = cosineSimilarity(observations[i].embedding, observations[j].embedding)
      totalPairs++
      if (sim < 0) {
        invalid++
      } else {
        buckets[bucketKeyFor(sim)] = (buckets[bucketKeyFor(sim)] ?? 0) + 1
      }
      if (sim >= similarityThreshold) {
        adjacency.get(observations[i].id)?.add(observations[j].id)
        adjacency.get(observations[j].id)?.add(observations[i].id)
      }
    }
  }

  const byId = new Map(observations.map((o) => [o.id, o]))
  for (const obs of observations) {
    if (visited.has(obs.id)) continue
    const queue = [obs.id]
    visited.add(obs.id)
    const component: EmbeddedObservation[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      const row = byId.get(id)
      if (row) component.push(row)
      for (const next of adjacency.get(id) ?? []) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }

    if (component.length >= minClusterSize) semanticGroups.push(component)
    else fallbackObservationIds.push(...component.map((c) => c.id))
  }

  return {
    semanticGroups,
    fallbackObservationIds,
    similarityHistogram: { buckets, invalid, totalPairs },
  }
}
