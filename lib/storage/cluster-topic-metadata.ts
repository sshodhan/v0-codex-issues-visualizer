import type { SupabaseClient } from "@supabase/supabase-js"

// Read-only helpers for the Layer-A cluster topic metadata MV
// (`mv_cluster_topic_metadata`, scripts/028). Layer 0 (the heuristic
// Topic classifier) writes per-observation evidence; this module
// surfaces *aggregated* per-cluster signals derived from that evidence
// for admin/debug use.
//
// What this module is NOT:
//   - it does not gate cluster membership (Layer A is embedding-first;
//     `lib/storage/semantic-clusters.ts` owns membership)
//   - it does not bucket observations into Topics (Layer 0 owns that
//     in `lib/scrapers/shared.ts → categorizeIssue`)
//   - it does not write anywhere (no RPCs, no inserts; the MV is
//     refreshed by `refresh_materialized_views()`)
//
// See docs/CLUSTERING_DESIGN.md §4.6 for the architectural contract.

export interface ClusterTopicPhrase {
  phrase: string
  count: number
}

export interface ClusterTopicMetadata {
  cluster_id: string
  cluster_key: string
  cluster_path: "semantic" | "fallback"
  /** Active member count (cluster_members where detached_at IS NULL). */
  observation_count: number
  /** Subset of observation_count with a v5 Topic decision. */
  classified_count: number
  /** observation_count - classified_count. Renamed `other_count` in
   *  the MV to match the wording used in admin panels. */
  other_count: number
  /** {slug → count}. Includes an `unclassified` bucket for members
   *  without a v5 evidence row, so values sum to observation_count. */
  topic_distribution: Record<string, number>
  /** {slug → count} of evidence.scoring.runner_up across members. */
  runner_up_distribution: Record<string, number>
  /** Lex-tiebroken mode of topic_distribution, excluding `unclassified`
   *  unless that's the only bucket. NULL only if observation_count=0. */
  dominant_topic_slug: string | null
  dominant_topic_count: number | null
  /** dominant_topic_count / observation_count, NUMERIC(5,4). 0 when
   *  observation_count is 0. */
  dominant_topic_share: number
  avg_confidence_proxy: number | null
  avg_topic_margin: number | null
  /** Members whose evidence.scoring.margin <= 2 (the v5 default
   *  threshold; close calls between Topics). */
  low_margin_count: number
  /** Shannon entropy over topic_distribution, normalised to [0, 1].
   *  0 = single-topic Family; 1 = uniform across observed buckets.
   *  Useful as a "this Family may need split-review" hint — NOT a
   *  hard split signal. */
  mixed_topic_score: number
  /** Top 10 phrases by frequency from evidence.matched_phrases across
   *  all members. Already ordered count-desc, phrase-asc. */
  common_matched_phrases: ClusterTopicPhrase[]
  computed_at: string
}

interface RawRow {
  cluster_id: string
  cluster_key: string
  cluster_path: string | null
  observation_count: number | null
  classified_count: number | null
  other_count: number | null
  topic_distribution: unknown
  runner_up_distribution: unknown
  dominant_topic_slug: string | null
  dominant_topic_count: number | null
  dominant_topic_share: number | string | null
  avg_confidence_proxy: number | string | null
  avg_topic_margin: number | string | null
  low_margin_count: number | null
  mixed_topic_score: number | string | null
  common_matched_phrases: unknown
  computed_at: string
}

const SELECT_COLUMNS =
  "cluster_id, cluster_key, cluster_path, observation_count, classified_count, other_count, " +
  "topic_distribution, runner_up_distribution, dominant_topic_slug, dominant_topic_count, " +
  "dominant_topic_share, avg_confidence_proxy, avg_topic_margin, low_margin_count, " +
  "mixed_topic_score, common_matched_phrases, computed_at"

// Postgres NUMERIC values arrive as strings via the supabase-js driver
// (no precision loss vs JS number, but typed as `string`). Coerce at
// the boundary so callers see consistent JS numbers.
function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") return value
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return value
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toDistribution(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number.parseInt(String(v ?? "0"), 10)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

function toPhrases(value: unknown): ClusterTopicPhrase[] {
  if (!Array.isArray(value)) return []
  const out: ClusterTopicPhrase[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const phrase = (entry as { phrase?: unknown }).phrase
    const count = (entry as { count?: unknown }).count
    if (typeof phrase !== "string") continue
    const n = typeof count === "number" ? count : Number.parseInt(String(count ?? "0"), 10)
    if (!Number.isFinite(n)) continue
    out.push({ phrase, count: n })
  }
  return out
}

function clusterPathOf(value: string | null): "semantic" | "fallback" {
  return value === "semantic" ? "semantic" : "fallback"
}

function rowToMetadata(row: RawRow): ClusterTopicMetadata {
  return {
    cluster_id: row.cluster_id,
    cluster_key: row.cluster_key,
    cluster_path: clusterPathOf(row.cluster_path),
    observation_count: row.observation_count ?? 0,
    classified_count: row.classified_count ?? 0,
    other_count: row.other_count ?? 0,
    topic_distribution: toDistribution(row.topic_distribution),
    runner_up_distribution: toDistribution(row.runner_up_distribution),
    dominant_topic_slug: row.dominant_topic_slug,
    dominant_topic_count: row.dominant_topic_count,
    dominant_topic_share: toNumber(row.dominant_topic_share),
    avg_confidence_proxy: toNullableNumber(row.avg_confidence_proxy),
    avg_topic_margin: toNullableNumber(row.avg_topic_margin),
    low_margin_count: row.low_margin_count ?? 0,
    mixed_topic_score: toNumber(row.mixed_topic_score),
    common_matched_phrases: toPhrases(row.common_matched_phrases),
    computed_at: row.computed_at,
  }
}

export async function getClusterTopicMetadata(
  supabase: SupabaseClient,
  clusterId: string,
): Promise<ClusterTopicMetadata | null> {
  const { data, error } = await supabase
    .from("mv_cluster_topic_metadata")
    .select(SELECT_COLUMNS)
    .eq("cluster_id", clusterId)
    .maybeSingle()
  if (error) {
    console.error("[cluster-topic-metadata] fetch failed:", error.message)
    return null
  }
  if (!data) return null
  return rowToMetadata(data as RawRow)
}

export interface ListClusterTopicMetadataOptions {
  clusterIds?: string[]
  /** Only return clusters with at least N active members. Defaults to 0. */
  minObservationCount?: number
  /** Only return clusters whose `mixed_topic_score` is at least this.
   *  Useful for surfacing "Families that may need review". */
  minMixedTopicScore?: number
  /** Filter by dominant Topic slug. */
  dominantTopicSlug?: string
  limit?: number
}

export async function listClusterTopicMetadata(
  supabase: SupabaseClient,
  options: ListClusterTopicMetadataOptions = {},
): Promise<ClusterTopicMetadata[]> {
  let query = supabase
    .from("mv_cluster_topic_metadata")
    .select(SELECT_COLUMNS)
    .order("observation_count", { ascending: false })

  if (options.clusterIds && options.clusterIds.length > 0) {
    query = query.in("cluster_id", options.clusterIds)
  }
  if (typeof options.minObservationCount === "number") {
    query = query.gte("observation_count", options.minObservationCount)
  }
  if (typeof options.minMixedTopicScore === "number") {
    query = query.gte("mixed_topic_score", options.minMixedTopicScore)
  }
  if (typeof options.dominantTopicSlug === "string") {
    query = query.eq("dominant_topic_slug", options.dominantTopicSlug)
  }
  if (typeof options.limit === "number" && options.limit > 0) {
    query = query.limit(options.limit)
  }

  const { data, error } = await query
  if (error) {
    console.error("[cluster-topic-metadata] list failed:", error.message)
    return []
  }
  return (data ?? []).map((r) => rowToMetadata(r as RawRow))
}

// Pure helpers exposed for tests + callers that already have a raw MV
// row from a join (e.g. embedded inside a wider /api/clusters payload)
// and want the same coercion + shape contract without a second query.
export const __testing = {
  rowToMetadata,
  toDistribution,
  toPhrases,
  toNumber,
  toNullableNumber,
}
