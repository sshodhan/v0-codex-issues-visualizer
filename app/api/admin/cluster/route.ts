import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  attachToCluster,
  buildClusterKey,
  detachFromCluster,
} from "@/lib/storage/clusters"

export const maxDuration = 60

// Operator surface for the clustering subsystem (lib/storage/clusters.ts,
// RPCs attach_to_cluster / detach_from_cluster). Attach-only rebuild is
// idempotent via the partial unique index idx_cluster_members_active;
// redetach first exists for the rare case where buildClusterKey itself
// changes.

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000
const SAMPLE_SIZE = 10

interface RebuildBody {
  action: "rebuild"
  cursor?: string | null
  limit?: number
  redetach?: boolean
}

interface DetachBody {
  action: "detach"
  observationId: string
}

type PostBody = RebuildBody | DetachBody

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const supabase = createAdminClient()

  const [obsCountRes, clusterCountRes, activeMembershipsRes, topRes] =
    await Promise.all([
      supabase.from("observations").select("*", { count: "exact", head: true }),
      supabase.from("clusters").select("*", { count: "exact", head: true }),
      supabase
        .from("cluster_members")
        .select("*", { count: "exact", head: true })
        .is("detached_at", null),
      supabase
        .from("mv_observation_current")
        .select("cluster_id, cluster_key, title, frequency_count")
        .eq("is_canonical", true)
        .not("cluster_id", "is", null)
        .order("frequency_count", { ascending: false })
        .limit(10),
    ])

  const firstError =
    obsCountRes.error ||
    clusterCountRes.error ||
    activeMembershipsRes.error ||
    topRes.error
  if (firstError) {
    return NextResponse.json({ error: firstError.message }, { status: 500 })
  }

  const observations = obsCountRes.count ?? 0
  const clusters = clusterCountRes.count ?? 0
  const active_memberships = activeMembershipsRes.count ?? 0
  const orphans = Math.max(0, observations - active_memberships)
  const top_clusters = (topRes.data ?? []).map((r) => ({
    cluster_id: r.cluster_id as string,
    cluster_key: r.cluster_key as string,
    canonical_title: r.title as string,
    frequency_count: (r.frequency_count as number) ?? 1,
  }))

  return NextResponse.json({
    observations,
    clusters,
    active_memberships,
    orphans,
    top_clusters,
  })
}

export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  let body: PostBody
  try {
    body = (await request.json()) as PostBody
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const supabase = createAdminClient()

  if (body.action === "detach") {
    if (!body.observationId) {
      return NextResponse.json(
        { error: "observationId required" },
        { status: 400 },
      )
    }
    await detachFromCluster(supabase, body.observationId)
    return NextResponse.json({ detached: body.observationId })
  }

  if (body.action === "rebuild") {
    const cursor = body.cursor ?? null
    const limit = Math.max(1, Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    const redetach = body.redetach === true

    let q = supabase
      .from("observations")
      .select("id, title")
      .order("id", { ascending: true })
      .limit(limit)
    if (cursor) q = q.gt("id", cursor)
    const res = await q
    if (res.error) {
      return NextResponse.json({ error: res.error.message }, { status: 500 })
    }
    const rows = res.data ?? []

    if (rows.length === 0) {
      return NextResponse.json({
        processed: 0,
        attached: 0,
        ...(redetach ? { detached: 0 } : {}),
        nextCursor: null,
        done: true,
        sampleKeys: [],
      })
    }

    let attached = 0
    let detached = 0
    const sampleKeys: Array<{ id: string; title: string; cluster_key: string }> = []
    const tasks: Promise<unknown>[] = []

    for (const row of rows) {
      const id = row.id as string
      const title = (row.title as string) ?? ""
      const key = buildClusterKey(title)
      if (sampleKeys.length < SAMPLE_SIZE) {
        sampleKeys.push({ id, title, cluster_key: key })
      }
      if (redetach) {
        tasks.push(
          detachFromCluster(supabase, id).then(() => {
            detached++
            return attachToCluster(supabase, id, title).then(() => {
              attached++
            })
          }),
        )
      } else {
        tasks.push(
          attachToCluster(supabase, id, title).then(() => {
            attached++
          }),
        )
      }
    }

    await Promise.all(tasks)

    const processed = rows.length
    const lastId = rows[rows.length - 1].id as string
    return NextResponse.json({
      processed,
      attached,
      ...(redetach ? { detached } : {}),
      nextCursor: processed < limit ? null : lastId,
      done: processed < limit,
      sampleKeys,
    })
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 })
}
