// Shared orchestrator for the deterministic cluster-label backfill.
//
// The CLI (scripts/021_backfill_deterministic_labels.ts) and the admin
// API route (app/api/admin/cluster-label-backfill) both go through
// this function so behaviour stays identical regardless of which
// surface invoked the run. The route adds an audit row and surfaces a
// success/failure result; the CLI prints a JSON summary and writes a
// dry-run report to disk. Neither is allowed to call the labeller
// without going through this orchestrator.

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  LABEL_MODEL,
  composeDeterministicLabel,
  type DeterministicLabel,
} from "./cluster-label-fallback.ts"
import { CURRENT_VERSIONS } from "./algorithm-versions.ts"

export interface BackfillEntry {
  cluster_id: string
  cluster_key: string | null
  member_count: number
  prior_label: string | null
  prior_confidence: number | null
  prior_model: string | null
  new_label: string
  new_confidence: number
  new_model: DeterministicLabel["model"]
}

export interface BackfillSummary {
  mode: "dry-run" | "apply"
  candidate_clusters: number
  relabelled: number
  by_model: Record<string, number>
  rpc_failures: number
}

export interface RunOptions {
  apply: boolean
  limit?: number
  batchSize?: number
  // Optional restriction to specific cluster IDs. The candidate filter
  // (label.is.null OR label_confidence < 0.6 OR legacy fallback) still
  // applies within the listed IDs unless `force` is set.
  // Used by app/api/clusters/[id]/label so a reviewer can trigger a
  // single-cluster relabel from the trace page.
  clusterIds?: string[]
  // Bypass the candidate filter — relabel even if the cluster already
  // has a strong label. Combined with `clusterIds: [id]` this is the
  // "force regenerate this one cluster's name" case.
  force?: boolean
}

interface ClusterRow {
  id: string
  cluster_key: string | null
  label: string | null
  label_confidence: number | null
  label_model: string | null
}

const DEFAULT_BATCH_SIZE = 200

export async function runClusterLabelBackfill(
  supabase: SupabaseClient,
  options: RunOptions,
): Promise<{ summary: BackfillSummary; entries: BackfillEntry[] }> {
  const apply = options.apply
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE

  let q = supabase
    .from("clusters")
    .select("id, cluster_key, label, label_confidence, label_model")
    .order("id", { ascending: true })
  if (!options.force) {
    q = q.or(
      `label.is.null,label_confidence.lt.0.6,label_model.eq.${LABEL_MODEL.LEGACY_FALLBACK_TITLE}`,
    )
  }
  if (options.clusterIds && options.clusterIds.length > 0) {
    q = q.in("id", options.clusterIds)
  }
  if (options.limit) q = q.limit(options.limit)
  const { data: clusterData, error: clusterErr } = await q
  if (clusterErr) {
    throw new Error(`cluster fetch failed: ${clusterErr.message}`)
  }
  const clusters = (clusterData ?? []) as ClusterRow[]

  const entries: BackfillEntry[] = []
  const modelTally: Record<string, number> = {}
  let rpcFailures = 0

  for (let i = 0; i < clusters.length; i += batchSize) {
    const chunk = clusters.slice(i, i + batchSize)
    const clusterIds = chunk.map((c) => c.id)

    const { data: memberRows, error: memberErr } = await supabase
      .from("cluster_members")
      .select("cluster_id, observation_id")
      .in("cluster_id", clusterIds)
      .is("detached_at", null)
    if (memberErr) {
      throw new Error(`member fetch failed: ${memberErr.message}`)
    }
    const membersByCluster = new Map<string, string[]>()
    for (const m of (memberRows ?? []) as Array<{
      cluster_id: string
      observation_id: string
    }>) {
      const list = membersByCluster.get(m.cluster_id) ?? []
      list.push(m.observation_id)
      membersByCluster.set(m.cluster_id, list)
    }

    const allObsIds = Array.from(
      new Set(Array.from(membersByCluster.values()).flatMap((ids) => ids)),
    )

    const titleByObs = new Map<string, string>()
    const topicSlugByObs = new Map<string, string>()
    const errorCodeByObs = new Map<string, string>()

    if (allObsIds.length > 0) {
      const [obsRes, catRes, fpRes] = await Promise.all([
        supabase.from("observations").select("id, title").in("id", allObsIds),
        supabase
          .from("category_assignments")
          .select("observation_id, computed_at, categories:category_id(slug)")
          .in("observation_id", allObsIds)
          .order("computed_at", { ascending: false }),
        supabase
          .from("bug_fingerprints")
          .select("observation_id, error_code, computed_at")
          .in("observation_id", allObsIds)
          .not("error_code", "is", null)
          .order("computed_at", { ascending: false }),
      ])

      for (const row of (obsRes.data ?? []) as Array<{
        id: string
        title: string | null
      }>) {
        if (row.title) titleByObs.set(row.id, row.title)
      }
      for (const row of (catRes.data ?? []) as unknown as Array<{
        observation_id: string
        categories: { slug: string } | null
      }>) {
        if (!topicSlugByObs.has(row.observation_id) && row.categories?.slug) {
          topicSlugByObs.set(row.observation_id, row.categories.slug)
        }
      }
      for (const row of (fpRes.data ?? []) as Array<{
        observation_id: string
        error_code: string | null
      }>) {
        if (!errorCodeByObs.has(row.observation_id) && row.error_code) {
          errorCodeByObs.set(row.observation_id, row.error_code)
        }
      }
    }

    for (const cluster of chunk) {
      const memberIds = membersByCluster.get(cluster.id) ?? []
      const titles = memberIds
        .map((id) => titleByObs.get(id) ?? "")
        .filter((t) => t.length > 0)
      const topicSlugs = memberIds.map((id) => topicSlugByObs.get(id) ?? null)
      const errorCodes = memberIds.map((id) => errorCodeByObs.get(id) ?? null)

      const fallback = composeDeterministicLabel({
        topicSlugs,
        errorCodes,
        titles,
      })
      entries.push({
        cluster_id: cluster.id,
        cluster_key: cluster.cluster_key,
        member_count: memberIds.length,
        prior_label: cluster.label,
        prior_confidence: cluster.label_confidence,
        prior_model: cluster.label_model,
        new_label: fallback.label,
        new_confidence: fallback.confidence,
        new_model: fallback.model,
      })
      modelTally[fallback.model] = (modelTally[fallback.model] ?? 0) + 1

      if (apply) {
        const { error } = await supabase.rpc("set_cluster_label", {
          cluster_uuid: cluster.id,
          lbl: fallback.label,
          lbl_rationale: fallback.rationale,
          lbl_confidence: fallback.confidence,
          lbl_model: fallback.model,
          lbl_alg_ver: CURRENT_VERSIONS.semantic_cluster_label,
        })
        if (error) rpcFailures += 1
      }
    }
  }

  return {
    summary: {
      mode: apply ? "apply" : "dry-run",
      candidate_clusters: clusters.length,
      relabelled: entries.length,
      by_model: modelTally,
      rpc_failures: rpcFailures,
    },
    entries,
  }
}

// Counts every cluster currently eligible for relabel, partitioned by
// label_model. Used by GET /api/admin/cluster-label-backfill so the
// operator can see "how much work would Run actually do" before
// authorising spend. Cheap: single grouped count, no member fan-out.
export async function getClusterLabelStats(supabase: SupabaseClient): Promise<{
  total: number
  candidates: number
  by_model: Array<{ label_model: string; clusters: number }>
}> {
  const { count: total, error: totalErr } = await supabase
    .from("clusters")
    .select("*", { count: "exact", head: true })
  if (totalErr) throw new Error(`total count failed: ${totalErr.message}`)

  const { count: candidates, error: candErr } = await supabase
    .from("clusters")
    .select("*", { count: "exact", head: true })
    .or(
      `label.is.null,label_confidence.lt.0.6,label_model.eq.${LABEL_MODEL.LEGACY_FALLBACK_TITLE}`,
    )
  if (candErr) throw new Error(`candidate count failed: ${candErr.message}`)

  const { data: byModelRows, error: byModelErr } = await supabase
    .from("clusters")
    .select("label_model")
  if (byModelErr) throw new Error(`by_model fetch failed: ${byModelErr.message}`)

  const tally = new Map<string, number>()
  for (const row of (byModelRows ?? []) as Array<{ label_model: string | null }>) {
    const key = row.label_model ?? "(null)"
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const by_model = Array.from(tally.entries())
    .map(([label_model, clusters]) => ({ label_model, clusters }))
    .sort((a, b) => b.clusters - a.clusters)

  return {
    total: total ?? 0,
    candidates: candidates ?? 0,
    by_model,
  }
}
