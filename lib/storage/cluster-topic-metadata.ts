import type { SupabaseClient } from "@supabase/supabase-js"

import { logServerError } from "../error-tracking/server-logger.ts"

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
// Failure logging routes through `logServerError` from
// `lib/error-tracking/server-logger.ts` so MV-not-applied / RLS / wire
// failures land on the structured-log dashboard alongside the rest of
// the read-side surfaces (`api-clusters`, `cluster-embedding`,
// `cluster-labeling`). Component name is `cluster-topic-metadata` so
// operators can grep one prefix to scope to this module.
//
// See docs/CLUSTERING_DESIGN.md §4.6 for the architectural contract.

const LOG_COMPONENT = "cluster-topic-metadata"

export interface ClusterTopicPhrase {
  /** Topic slug the phrase was scored under by Layer 0. The same
   *  surface phrase can score for more than one slug; `(slug, phrase)`
   *  is the unique unit of evidence. */
  slug: string
  phrase: string
  count: number
}

export interface ClusterTopicMetadata {
  cluster_id: string
  cluster_key: string
  cluster_path: "semantic" | "fallback"
  /** Active member count (cluster_members where detached_at IS NULL). */
  observation_count: number
  /** Subset of observation_count with a current-version Topic decision. */
  classified_count: number
  /** observation_count - classified_count. Members the classifier
   *  hasn't (re-)processed yet. Distinct from the categories.slug =
   *  'other' bucket, which is a real Topic decision. */
  unclassified_count: number
  /** classified_count / observation_count. Compare to mixed_topic_score
   *  to disambiguate "Family genuinely spans Topics" from "Layer 0
   *  hasn't caught up yet": high mixed score with low coverage is the
   *  latter. */
  classification_coverage_share: number
  /** {slug → count}. Includes an `unclassified` bucket for members
   *  without an evidence row, so values sum to observation_count. */
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
  /** Mean of evidence.scoring.confidence_proxy across members. Each
   *  member's value is clamped to [0, 1] by Layer 0. NULL when no
   *  member has current-version evidence. */
  avg_confidence_proxy: number | null
  /** Mean of evidence.scoring.margin (winnerScore − runnerUpScore in
   *  raw weighted-phrase units). NOT bounded to [0, 1] — a single
   *  observation with several w4 title phrases routinely produces
   *  margin ≥ 100. NULL when no member has current-version evidence. */
  avg_topic_margin: number | null
  /** Members whose evidence.scoring.margin <= 2 (the v5 default
   *  threshold; close calls between Topics). */
  low_margin_count: number
  /** Shannon entropy over topic_distribution, normalised to [0, 1].
   *  0 = single-topic Family; 1 = uniform across observed buckets.
   *  Includes the `unclassified` bucket — pair with
   *  classification_coverage_share to disambiguate genuine topic mix
   *  from missing evidence. Hint for human review, NOT a split gate. */
  mixed_topic_score: number
  /** Top 10 (slug, phrase) tuples by frequency from
   *  evidence.matched_phrases across all members. Already ordered
   *  count-desc, slug-asc, phrase-asc. */
  common_matched_phrases: ClusterTopicPhrase[]
  /** Statement time of the last `refresh_materialized_views()`
   *  invocation that touched this MV. Useful as a freshness
   *  indicator on admin/debug surfaces — anything older than the
   *  cron cadence suggests the refresh hook is stuck. */
  computed_at: string
}

interface RawRow {
  cluster_id: string
  cluster_key: string
  cluster_path: string | null
  observation_count: number | null
  classified_count: number | null
  unclassified_count: number | null
  classification_coverage_share: number | string | null
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
  "cluster_id, cluster_key, cluster_path, observation_count, classified_count, " +
  "unclassified_count, classification_coverage_share, topic_distribution, " +
  "runner_up_distribution, dominant_topic_slug, dominant_topic_count, " +
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
    const slug = (entry as { slug?: unknown }).slug
    const phrase = (entry as { phrase?: unknown }).phrase
    const count = (entry as { count?: unknown }).count
    if (typeof phrase !== "string") continue
    const n = typeof count === "number" ? count : Number.parseInt(String(count ?? "0"), 10)
    if (!Number.isFinite(n)) continue
    out.push({
      slug: typeof slug === "string" && slug.length > 0 ? slug : "unknown",
      phrase,
      count: n,
    })
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
    unclassified_count: row.unclassified_count ?? 0,
    classification_coverage_share: toNumber(row.classification_coverage_share),
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
    logServerError(LOG_COMPONENT, "fetch_failed", error, {
      cluster_id: clusterId,
    })
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
    logServerError(LOG_COMPONENT, "list_failed", error, {
      cluster_id_count: options.clusterIds?.length ?? null,
      min_observation_count: options.minObservationCount ?? null,
      min_mixed_topic_score: options.minMixedTopicScore ?? null,
      dominant_topic_slug: options.dominantTopicSlug ?? null,
      limit: options.limit ?? null,
    })
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
