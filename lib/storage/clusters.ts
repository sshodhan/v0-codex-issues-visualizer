import type { createAdminClient } from "@/lib/supabase/admin"
import {
  buildTitleClusterKey,
  normalizeTitleForCluster,
} from "@/lib/storage/cluster-key"

// Aggregation-layer entry points. Physical cluster membership is written
// by the semantic-clustering pass in lib/storage/semantic-clusters.ts,
// which calls attachToCluster with a semantic-cluster key. The
// title-only fallback below is the deterministic path used when the
// embedding call fails or no semantic cluster can form yet.
//
// Key-derivation helpers live in cluster-key.ts so the bug-fingerprint
// extractor can share normalizeTitleForCluster / buildTitleClusterKey
// without pulling in the DB-facing RPCs. The bug fingerprint produces a
// *display/audit* compound key (title|err:<code>|frame:<fh>) that is
// persisted on bug_fingerprints.cluster_key_compound but is NOT the
// physical cluster key — physical clustering is owned by the semantic
// pass (docs/ARCHITECTURE.md v11 §3.1c).

type AdminClient = ReturnType<typeof createAdminClient>

export { buildTitleClusterKey, normalizeTitleForCluster }

// Back-compat alias. New callers should prefer buildTitleClusterKey.
export const buildClusterKey = buildTitleClusterKey

export async function attachToCluster(
  supabase: AdminClient,
  observationId: string,
  title: string,
): Promise<string | null> {
  const key = buildTitleClusterKey(title)
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
