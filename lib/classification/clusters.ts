// Pure aggregation for /api/clusters. Extracted from the route handler
// so `node --test --experimental-strip-types` can import it directly
// and characterize the grouping/filtering/sorting invariants without
// standing up a Supabase client.
//
// Contract:
//  - Input rows are pre-ordered by `impact_score DESC`. The caller
//    (route handler) enforces that via Supabase `.order()`; the
//    grouper relies on it so that the first N sample titles per
//    cluster are the top-impact ones.
//  - Rows with `cluster_id === null` are silently skipped.
//  - Title-hash fallback singletons (`title:<md5>` and `size < 2`) are
//    filtered out — they carry no more signal than the existing
//    category group-by and would add chip noise (data-scientist
//    review finding H2 from the previous PR).
//  - Output is sorted by `in_window DESC` with `size DESC` as the
//    tiebreaker so high-impact clusters don't get buried when the
//    reviewer narrows the time window.
//
// See docs/CLUSTERING_DESIGN.md §7 and app/api/clusters/route.ts.

export interface ClusterObservationRow {
  observation_id: string
  title: string | null
  url: string | null
  cluster_id: string | null
  cluster_key: string | null
  llm_classified_at: string | null
  frequency_count: number | null
  impact_score: number | null
  sentiment: string | null
}

export interface ClusterLabelRow {
  id: string
  cluster_key: string
  label: string | null
  label_confidence: number | null
}

export interface ClusterSample {
  observation_id: string
  title: string
  url: string | null
  impact_score: number
  sentiment: string | null
}

export interface ClusterSummary {
  id: string
  cluster_key: string
  label: string | null
  label_confidence: number | null
  size: number
  in_window: number
  classified_count: number
  reviewed_count: number
  cluster_path: "semantic" | "fallback"
  fingerprint_hit_rate: number
  dominant_error_code_share: number
  dominant_stack_frame_share: number
  intra_cluster_similarity_proxy: number
  nearest_cluster_gap_proxy: number
  samples: ClusterSample[]
}

export interface ClusterHealthRow {
  cluster_id: string
  cluster_path: "semantic" | "fallback"
  cluster_size: number
  classified_count: number
  reviewed_count: number
  fingerprint_hit_rate: number
  dominant_error_code_share: number
  dominant_stack_frame_share: number
  intra_cluster_similarity_proxy: number
  nearest_cluster_gap_proxy: number
}

export function aggregateClusters(
  rows: ClusterObservationRow[],
  labels: ClusterLabelRow[],
  healthRows: ClusterHealthRow[],
  options: { limit: number; samplesPerCluster: number },
): ClusterSummary[] {
  const labelMap = new Map<string, ClusterLabelRow>()
  for (const l of labels) labelMap.set(l.id, l)
  const healthMap = new Map<string, ClusterHealthRow>()
  for (const h of healthRows) healthMap.set(h.cluster_id, h)

  const byCluster = new Map<
    string,
    {
      id: string
      cluster_key: string
      size: number
      in_window: number
      classified_count: number
      samples: ClusterSample[]
    }
  >()

  for (const r of rows) {
    if (!r.cluster_id) continue
    const entry = byCluster.get(r.cluster_id) ?? {
      id: r.cluster_id,
      cluster_key: r.cluster_key ?? "",
      size: Number(r.frequency_count ?? 0),
      in_window: 0,
      classified_count: 0,
      samples: [] as ClusterSample[],
    }
    entry.in_window += 1
    if (r.llm_classified_at) entry.classified_count += 1
    if (entry.samples.length < options.samplesPerCluster) {
      entry.samples.push({
        observation_id: r.observation_id,
        title: r.title ?? "Untitled observation",
        url: r.url,
        impact_score: Number(r.impact_score ?? 0),
        sentiment: r.sentiment ?? null,
      })
    }
    byCluster.set(r.cluster_id, entry)
  }

  return Array.from(byCluster.values())
    .map((entry) => {
      const label = labelMap.get(entry.id) ?? null
      const health = healthMap.get(entry.id)
      const clusterPath: "semantic" | "fallback" = health?.cluster_path
        ?? (entry.cluster_key.startsWith("semantic:") ? "semantic" : "fallback")
      return {
        id: entry.id,
        cluster_key: entry.cluster_key,
        label: label?.label ?? null,
        label_confidence: label?.label_confidence ?? null,
        size: entry.size,
        in_window: entry.in_window,
        classified_count: entry.classified_count,
        reviewed_count: health?.reviewed_count ?? 0,
        cluster_path: clusterPath,
        fingerprint_hit_rate: Number(health?.fingerprint_hit_rate ?? 0),
        dominant_error_code_share: Number(health?.dominant_error_code_share ?? 0),
        dominant_stack_frame_share: Number(health?.dominant_stack_frame_share ?? 0),
        intra_cluster_similarity_proxy: Number(health?.intra_cluster_similarity_proxy ?? 0),
        nearest_cluster_gap_proxy: Number(health?.nearest_cluster_gap_proxy ?? 0),
        samples: entry.samples,
      }
    })
    .filter((c) => c.cluster_key.startsWith("semantic:") || c.size >= 2)
    .sort((a, b) => b.in_window - a.in_window || b.size - a.size)
    .slice(0, options.limit)
}
