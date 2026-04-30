import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  attachToCluster,
  buildClusterKey,
  detachFromCluster,
} from "@/lib/storage/clusters"
import {
  runSemanticClusteringForBatch,
  type SemanticClusterRunResult,
} from "@/lib/storage/semantic-clusters"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

export const maxDuration = 300

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000
const SAMPLE_SIZE = 10

interface RebuildBody {
  action: "rebuild"
  cursor?: string | null
  limit?: number
  redetach?: boolean
  mode?: "title-hash" | "semantic"
  similarityThreshold?: number
  minClusterSize?: number
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

  const [obsCountRes, clusterCountRes, activeMembershipsRes, topRes, prefixRes] =
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
      // Pull cluster_key prefixes for ACTIVE clusters only — clusters with
      // no live members are leftover detritus from prior redetach cycles
      // and shouldn't skew the operator's mental model of "what does the
      // pipeline currently produce?". Inner-join via cluster_members so
      // empty cluster rows don't get counted.
      supabase
        .from("cluster_members")
        .select("cluster_id, clusters!inner(cluster_key)")
        .is("detached_at", null),
    ])

  const firstError =
    obsCountRes.error ||
    clusterCountRes.error ||
    activeMembershipsRes.error ||
    topRes.error
  if (firstError) {
    return NextResponse.json({ error: firstError.message }, { status: 500 })
  }
  // Prefix query is best-effort: if it fails, log and continue with
  // empty distribution. The numbers cards above still render.
  if (prefixRes.error) {
    logServerError("admin-cluster", "prefix_distribution_query_failed", prefixRes.error)
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

  // Build {semantic, title, other} histogram of cluster_key prefixes.
  // De-duplicate by cluster_id first since cluster_members may have
  // multiple active rows per cluster (one per observation).
  const seenClusterIds = new Set<string>()
  const cluster_path_distribution = { semantic: 0, title: 0, other: 0 }
  for (const row of (prefixRes.data ?? []) as unknown as Array<{
    cluster_id: string
    clusters: { cluster_key: string } | { cluster_key: string }[]
  }>) {
    if (seenClusterIds.has(row.cluster_id)) continue
    seenClusterIds.add(row.cluster_id)
    const clusterRel = Array.isArray(row.clusters) ? row.clusters[0] : row.clusters
    const key = clusterRel?.cluster_key ?? ""
    if (key.startsWith("semantic:")) cluster_path_distribution.semantic++
    else if (key.startsWith("title:")) cluster_path_distribution.title++
    else cluster_path_distribution.other++
  }

  return NextResponse.json({
    observations,
    clusters,
    active_memberships,
    orphans,
    active_clusters: seenClusterIds.size,
    cluster_path_distribution,
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
    logServer({
      component: "admin-cluster",
      event: "detach_single",
      level: "info",
      data: { observationId: body.observationId },
    })
    await detachFromCluster(supabase, body.observationId)
    return NextResponse.json({ detached: body.observationId })
  }

  if (body.action === "rebuild") {
    const cursor = body.cursor ?? null
    const limit = Math.max(1, Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    const redetach = body.redetach === true
    const mode = body.mode ?? "title-hash"
    const similarityThreshold = body.similarityThreshold
    const minClusterSize = body.minClusterSize

    if (!cursor) {
      logServer({
        component: "admin-cluster",
        event: "rebuild_started",
        level: "info",
        data: { limit, redetach, mode, similarityThreshold, minClusterSize },
      })
    }
    // Per-batch start event so an operator scanning Vercel logs can
    // correlate later embedding/labeling failures with which page of
    // observations was being processed when they occurred.
    logServer({
      component: "admin-cluster",
      event: "rebuild_batch_started",
      level: "info",
      data: { cursor, limit, redetach, mode, similarityThreshold, minClusterSize },
    })

    let q = supabase
      .from("observations")
      .select("id, title, content")
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
        semanticAttached: 0,
        fallbackAttached: 0,
        fallbackEmbeddingFailures: 0,
        ...(redetach ? { detached: 0 } : {}),
        nextCursor: null,
        done: true,
        sampleKeys: [],
      })
    }

    let attached = 0
    let detached = 0
    let semanticAttached = 0
    let fallbackAttached = 0
    let fallbackEmbeddingFailures = 0
    let embeddingStats: SemanticClusterRunResult["embeddingStats"] | null = null
    let semanticGroupsFormed = 0
    let largestGroupSize = 0
    let similarityHistogram: SemanticClusterRunResult["similarityHistogram"] | null = null
    const sampleKeys: Array<{ id: string; title: string; cluster_key: string }> = []

    if (mode === "semantic") {
      // Pull Topic slug + latest error code per observation in this batch
      // so the labeller has the deterministic-fallback signals it needs
      // (lib/storage/cluster-label-fallback.ts). Both lookups are best-
      // effort: missing rows just leave the field null, which the
      // fallback handles gracefully.
      const ids = rows.map((row) => row.id as string)
      const topicSlugById = new Map<string, string>()
      const errorCodeById = new Map<string, string>()
      if (ids.length > 0) {
        const [catRes, fpRes] = await Promise.all([
          supabase
            .from("category_assignments")
            .select("observation_id, computed_at, categories:category_id(slug)")
            .in("observation_id", ids)
            .order("computed_at", { ascending: false }),
          supabase
            .from("bug_fingerprints")
            .select("observation_id, error_code, computed_at")
            .in("observation_id", ids)
            .not("error_code", "is", null)
            .order("computed_at", { ascending: false }),
        ])
        // PostgREST inflates the embedded `categories(slug)` join as a
        // single object at runtime, but Supabase's generated typings
        // model it as an array — cast through unknown to bridge that
        // gap. Same pattern as scripts/013_backfill_fingerprints.ts.
        for (const row of (catRes.data ?? []) as unknown as Array<{
          observation_id: string
          categories: { slug: string } | null
        }>) {
          if (!topicSlugById.has(row.observation_id) && row.categories?.slug) {
            topicSlugById.set(row.observation_id, row.categories.slug)
          }
        }
        for (const row of (fpRes.data ?? []) as Array<{
          observation_id: string
          error_code: string | null
        }>) {
          if (!errorCodeById.has(row.observation_id) && row.error_code) {
            errorCodeById.set(row.observation_id, row.error_code)
          }
        }
      }

      const semanticResult = await runSemanticClusteringForBatch(
        supabase,
        rows.map((row) => ({
          id: row.id as string,
          title: ((row.title as string) ?? "").trim(),
          content: (row.content as string | null) ?? null,
          topicSlug: topicSlugById.get(row.id as string) ?? null,
          errorCode: errorCodeById.get(row.id as string) ?? null,
        })),
        {
          similarityThreshold: body.similarityThreshold,
          minClusterSize: body.minClusterSize,
          redetach,
        },
      )
      semanticAttached = semanticResult.semanticAttached
      fallbackAttached = semanticResult.fallbackAttached
      fallbackEmbeddingFailures = semanticResult.embeddingFailures
      embeddingStats = semanticResult.embeddingStats
      semanticGroupsFormed = semanticResult.semanticGroupsFormed
      largestGroupSize = semanticResult.largestGroupSize
      similarityHistogram = semanticResult.similarityHistogram
      attached = semanticAttached + fallbackAttached
      detached = redetach ? rows.length : 0
    } else {
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
    }

    const processed = rows.length
    const lastId = rows[rows.length - 1].id as string
    const done = processed < limit

    let refreshedMvs = false
    if (done) {
      const { error: refreshErr } = await supabase.rpc("refresh_materialized_views")
      if (refreshErr) {
        logServerError("admin-cluster", "mv_refresh_failed", refreshErr)
      } else {
        refreshedMvs = true
      }
      logServer({
        component: "admin-cluster",
        event: "rebuild_completed",
        level: "info",
        data: {
          mode,
          attached,
          semanticAttached,
          fallbackAttached,
          fallbackEmbeddingFailures,
          detached: redetach ? detached : undefined,
          refreshedMvs,
        },
      })
    }

    return NextResponse.json({
      mode,
      processed,
      attached,
      semanticAttached,
      fallbackAttached,
      fallbackEmbeddingFailures,
      ...(redetach ? { detached } : {}),
      nextCursor: done ? null : lastId,
      done,
      refreshedMvs,
      sampleKeys,
      // Surfaced to the admin UI so an operator can see, per batch:
      // — embedding cache hit/miss + fetch latency
      // — how many real semantic groups formed and the largest size
      // — pairwise similarity histogram for threshold tuning
      // Fields are null in title-hash mode (no embedding/similarity work).
      embeddingStats,
      semanticGroupsFormed,
      largestGroupSize,
      similarityHistogram,
      similarityThreshold,
      minClusterSize,
    })
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 })
}
