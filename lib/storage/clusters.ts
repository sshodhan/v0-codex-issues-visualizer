import { createHash } from "node:crypto"
import type { createAdminClient } from "@/lib/supabase/admin"

// Clustering is an aggregation-layer concern. Evidence rows are never mutated
// by attach/detach — only cluster_members is written. See
// docs/ARCHITECTURE.md v10 §§3.1c, 5.3, 4.7.

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Normalize a title for cluster-key derivation. Unicode-aware so non-Latin
 * titles produce stable keys rather than collapsing to an empty bucket
 * (addresses the P1-12 failure mode from the previous design).
 */
export function normalizeTitleForCluster(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Deterministic cluster key for a given title. MD5 of the normalized form,
 * prefixed so the column is self-describing. Empty titles collapse to
 * "title:empty" but this is rare once Unicode normalization is in place.
 */
export function buildClusterKey(title: string): string {
  const normalized = normalizeTitleForCluster(title)
  if (!normalized) return "title:empty"
  const hash = createHash("md5").update(normalized).digest("hex").slice(0, 16)
  return `title:${hash}`
}

export async function attachToCluster(
  supabase: AdminClient,
  observationId: string,
  title: string,
): Promise<string | null> {
  const key = buildClusterKey(title)
  const { data, error } = await supabase.rpc("attach_to_cluster", {
    obs_id: observationId,
    key,
  })
  if (error) {
    console.error("[clusters] attach_to_cluster failed:", error)
    return null
  }
  return data as string | null
}

export async function detachFromCluster(
  supabase: AdminClient,
  observationId: string,
): Promise<void> {
  const { error } = await supabase.rpc("detach_from_cluster", {
    obs_id: observationId,
  })
  if (error) console.error("[clusters] detach_from_cluster failed:", error)
}
