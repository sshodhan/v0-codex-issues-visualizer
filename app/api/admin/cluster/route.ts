import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  attachToCluster,
  detachFromCluster,
  buildClusterKey,
} from "@/lib/storage/clusters"

// Admin endpoint for cluster maintenance. Three operations:
//
//   GET                           → current cluster stats (count, top-N, orphans)
//   POST { action: "rebuild" }    → chunked rebuild (keyset paginated)
//   POST { action: "detach", id } → detach one observation (debugging)
//
// The rebuild is chunked the same way as the derivation backfill: UI calls in
// a loop with a cursor. attach_to_cluster is idempotent via the
// partial-unique index on (cluster_id, observation_id) WHERE detached_at IS
// NULL, so re-running the same chunk is a no-op.
//
// Rebuild is useful when normalizeTitleForCluster changes (edge-case fix,
// Unicode handling, etc.) — old cluster_keys may no longer match the new
// normalization rule. This endpoint computes the current key for each
// observation and calls attach_to_cluster, which upserts the cluster row
// and records membership.
//
// It does NOT detach old memberships — that's an additive migration. If a
// schema/normalization change requires mass detach-then-reattach, pass
// `{ action: "rebuild", redetach: true }` which detaches each observation
// before re-attaching (single transaction isn't guaranteed across the two
// RPCs, but the pair is idempotent, so a partial failure + rerun converges).

export const maxDuration = 60

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000

function authorize(request: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_SECRET
  if (!expected) return null
  const provided = request.headers.get("x-admin-secret")
  if (provided === expected) return null
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(request: NextRequest) {
  const unauthorized = authorize(request)
  if (unauthorized) return unauthorized

  const supabase = createAdminClient()

  const [obsCount, clusterCount, activeMembers] = await Promise.all([
    supabase.from("observations").select("*", { count: "exact", head: true }),
    supabase.from("clusters").select("*", { count: "exact", head: true }),
    supabase
      .from("cluster_members")
      .select("*", { count: "exact", head: true })
      .is("detached_at", null),
  ])

  // Top-10 clusters by active member count. Pulls only what's needed for the
  // admin view — a fuller stats page would paginate.
  const { data: topClusters } = await supabase
    .from("mv_observation_current")
    .select("cluster_id, cluster_key, frequency_count, title, is_canonical")
    .eq("is_canonical", true)
    .order("frequency_count", { ascending: false, nullsFirst: false })
    .limit(10)

  return NextResponse.json({
    observations: obsCount.count ?? 0,
    clusters: clusterCount.count ?? 0,
    active_memberships: activeMembers.count ?? 0,
    orphans: (obsCount.count ?? 0) - (activeMembers.count ?? 0),
    top_clusters:
      topClusters?.map((c) => ({
        cluster_id: c.cluster_id,
        cluster_key: c.cluster_key,
        canonical_title: c.title,
        frequency: c.frequency_count ?? 0,
      })) ?? [],
  })
}

interface ClusterPostBody {
  action?: "rebuild" | "detach"
  cursor?: string | null
  limit?: number
  redetach?: boolean
  observationId?: string
}

export async function POST(request: NextRequest) {
  const unauthorized = authorize(request)
  if (unauthorized) return unauthorized

  const body: ClusterPostBody = await request.json().catch(() => ({}))
  const action = body.action ?? "rebuild"
  const supabase = createAdminClient()

  if (action === "detach") {
    if (!body.observationId) {
      return NextResponse.json({ error: "observationId is required for detach" }, { status: 400 })
    }
    await detachFromCluster(supabase, body.observationId)
    return NextResponse.json({ detached: body.observationId })
  }

  if (action !== "rebuild") {
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 })
  }

  const cursor = body.cursor ?? null
  const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
  const redetach = body.redetach === true

  let q = supabase
    .from("observations")
    .select("id, title")
    .order("id", { ascending: true })
    .limit(limit)
  if (cursor) q = q.gt("id", cursor)

  const { data: observations, error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!observations || observations.length === 0) {
    return NextResponse.json({
      processed: 0,
      attached: 0,
      nextCursor: null,
      done: true,
    })
  }

  let attached = 0
  let detached = 0
  const sampleKeys: Array<{ id: string; title: string; cluster_key: string }> = []

  for (const obs of observations) {
    const title = obs.title ?? ""
    if (redetach) {
      await detachFromCluster(supabase, obs.id)
      detached++
    }
    const clusterId = await attachToCluster(supabase, obs.id, title)
    if (clusterId) attached++

    if (sampleKeys.length < 10) {
      sampleKeys.push({
        id: obs.id,
        title: title.slice(0, 120),
        cluster_key: buildClusterKey(title),
      })
    }
  }

  const nextCursor = observations[observations.length - 1].id
  const done = observations.length < limit

  return NextResponse.json({
    processed: observations.length,
    attached,
    detached,
    nextCursor: done ? null : nextCursor,
    done,
    sampleKeys,
  })
}
