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

  const [obsCountRes, clusterCountRes, activeMembershipsRes, topRes, prefixRes, qualityRes] =
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
      // Cluster-quality lens: the existing cluster-health MV already
      // computes per-cluster homogeneity (what fraction of members share
      // the dominant error_code / top_stack_frame). We pull only
      // multi-member clusters because singleton "clusters" are
      // tautologically homogeneous (share=1) and would skew any average
      // we compute, masking real quality signal.
      supabase
        .from("mv_cluster_health_current")
        .select(
          "cluster_id, cluster_size, dominant_error_code_share, dominant_stack_frame_share",
        )
        .gte("cluster_size", 2),
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
  if (qualityRes.error) {
    logServerError("admin-cluster", "cluster_quality_query_failed", qualityRes.error)
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
  // multiple active rows per cluster (one per observation). When the
  // upstream query failed we explicitly return `null` so the UI can
  // render "—" instead of a misleading "0 of everything" zero state.
  let cluster_path_distribution: { semantic: number; title: number; other: number } | null
  let active_clusters: number | null
  if (prefixRes.error) {
    cluster_path_distribution = null
    active_clusters = null
  } else {
    const seenClusterIds = new Set<string>()
    const dist = { semantic: 0, title: 0, other: 0 }
    for (const row of (prefixRes.data ?? []) as unknown as Array<{
      cluster_id: string
      clusters: { cluster_key: string } | { cluster_key: string }[]
    }>) {
      if (seenClusterIds.has(row.cluster_id)) continue
      seenClusterIds.add(row.cluster_id)
      const clusterRel = Array.isArray(row.clusters) ? row.clusters[0] : row.clusters
      const key = clusterRel?.cluster_key ?? ""
      if (key.startsWith("semantic:")) dist.semantic++
      else if (key.startsWith("title:")) dist.title++
      else dist.other++
    }
    cluster_path_distribution = dist
    active_clusters = seenClusterIds.size
  }

  // Aggregate cluster-quality across multi-member clusters. The MV
  // computes per-cluster shares; we need a portfolio view: are MOST
  // clusters coherent, or only a few? Unweighted average so a single
  // huge incoherent cluster doesn't dwarf many small good ones.
  // CAVEAT: dominant_error_code_share is computed as
  // (top_count / cluster_size) — clusters where many members lack any
  // bug_fingerprint look "incoherent" even when their fingerprinted
  // members agree. The UI text below names this caveat.
  let cluster_quality:
    | {
        multi_member_clusters: number
        avg_dominant_error_share: number
        avg_dominant_stack_frame_share: number
        clusters_with_perfect_error_share: number
        clusters_with_low_error_share: number
      }
    | null
  if (qualityRes.error) {
    cluster_quality = null
  } else {
    const rows = (qualityRes.data ?? []) as Array<{
      cluster_id: string
      cluster_size: number
      dominant_error_code_share: number | string | null
      dominant_stack_frame_share: number | string | null
    }>
    const multi = rows.filter((r) => Number(r.cluster_size) >= 2)
    if (multi.length === 0) {
      cluster_quality = {
        multi_member_clusters: 0,
        avg_dominant_error_share: 0,
        avg_dominant_stack_frame_share: 0,
        clusters_with_perfect_error_share: 0,
        clusters_with_low_error_share: 0,
      }
    } else {
      // PostgREST sometimes returns numeric columns as strings; coerce
      // defensively so AVG isn't accidentally string-concatenating.
      const errShares = multi.map((r) => Number(r.dominant_error_code_share ?? 0))
      const frameShares = multi.map((r) => Number(r.dominant_stack_frame_share ?? 0))
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
      cluster_quality = {
        multi_member_clusters: multi.length,
        avg_dominant_error_share: Number(avg(errShares).toFixed(4)),
        avg_dominant_stack_frame_share: Number(avg(frameShares).toFixed(4)),
        // "Perfect" = every member with an error_code has the same one.
        // "Low" = the dominant error_code accounts for less than half the
        // cluster — a fairly forgiving floor for "incoherent."
        clusters_with_perfect_error_share: errShares.filter((s) => s >= 0.999).length,
        clusters_with_low_error_share: errShares.filter((s) => s < 0.5).length,
      }
    }
  }

  return NextResponse.json({
    observations,
    clusters,
    active_memberships,
    orphans,
    active_clusters,
    cluster_path_distribution,
    cluster_quality,
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
    let embeddingSignalCoverage:
      | SemanticClusterRunResult["embeddingSignalCoverage"]
      | null = null
    let semanticGroupsFormed = 0
    let largestGroupSize = 0
    let similarityHistogram: SemanticClusterRunResult["similarityHistogram"] | null = null
    const sampleKeys: Array<{ id: string; title: string; cluster_key: string }> = []

    if (mode === "semantic") {
      // Pull every per-observation signal we feed into the v2 embedding
      // input (Type / Error / Component / Stack / Platform). All four
      // lookups are best-effort: a missing fingerprint or family row
      // just leaves the corresponding tag absent in the embedding text,
      // and buildEmbeddingInputText degrades gracefully to prose-only
      // input. Topic + ErrorCode are also still consumed by the
      // deterministic-fallback labeller (cluster-label-fallback.ts) so
      // those two are not embedding-only signals.
      const ids = rows.map((row) => row.id as string)
      const topicSlugById = new Map<string, string>()
      const errorCodeById = new Map<string, string>()
      const topStackFrameById = new Map<string, string>()
      const platformById = new Map<string, string>()
      const familyKindById = new Map<string, string>()
      if (ids.length > 0) {
        // Step 1: pull all per-observation signals that live on
        // observation-keyed tables (categories + fingerprints) plus the
        // observation→cluster mapping. We CANNOT rely on PostgREST's
        // nested-embed `family_classification_current!inner(...)`
        // because the view has no FK relationship to cluster_members
        // — PostgREST's relationship auto-detection only works on real
        // FKs on tables, not on views like this one. So we do two
        // explicit lookups: cluster_members → cluster_id, then
        // family_classification_current → family_kind keyed on
        // cluster_id.
        const [catRes, fpRes, memberRes] = await Promise.all([
          supabase
            .from("category_assignments")
            .select("observation_id, computed_at, categories:category_id(slug)")
            .in("observation_id", ids)
            .order("computed_at", { ascending: false }),
          supabase
            .from("bug_fingerprints")
            .select("observation_id, error_code, top_stack_frame, os, computed_at")
            .in("observation_id", ids)
            .order("computed_at", { ascending: false }),
          supabase
            .from("cluster_members")
            .select("observation_id, cluster_id")
            .in("observation_id", ids)
            .is("detached_at", null),
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
        // Single fingerprint pass populates all three fingerprint-derived
        // signals — error_code, top_stack_frame, os — taking the first
        // (most recent by computed_at) row per observation.
        for (const row of (fpRes.data ?? []) as Array<{
          observation_id: string
          error_code: string | null
          top_stack_frame: string | null
          os: string | null
        }>) {
          if (row.error_code && !errorCodeById.has(row.observation_id)) {
            errorCodeById.set(row.observation_id, row.error_code)
          }
          if (row.top_stack_frame && !topStackFrameById.has(row.observation_id)) {
            topStackFrameById.set(row.observation_id, row.top_stack_frame)
          }
          if (row.os && !platformById.has(row.observation_id)) {
            platformById.set(row.observation_id, row.os)
          }
        }

        // Step 2: collect distinct cluster_ids the batch's observations
        // currently sit in, then look up family_kind for those clusters
        // in one query. Mapping is observation → cluster → family_kind.
        // CAVEAT (also documented in PR description): during a re-detach
        // rebuild, the cluster_id we resolve here is the obs's PRIOR
        // cluster — the new cluster_id created by this rebuild won't
        // exist until later in the loop, and won't have a family
        // classification at all until the family-classification drain
        // re-runs on the new groupings. So v2 embeddings during the
        // first re-detach use stale family_kind; that's better than
        // none, and post-rebuild verification step #6 covers the
        // re-classify follow-up.
        const obsToCluster = new Map<string, string>()
        const clusterIds = new Set<string>()
        for (const row of (memberRes.data ?? []) as Array<{
          observation_id: string
          cluster_id: string
        }>) {
          if (row.cluster_id && !obsToCluster.has(row.observation_id)) {
            obsToCluster.set(row.observation_id, row.cluster_id)
            clusterIds.add(row.cluster_id)
          }
        }
        if (clusterIds.size > 0) {
          const { data: famRows, error: famErr } = await supabase
            .from("family_classification_current")
            .select("cluster_id, family_kind")
            .in("cluster_id", Array.from(clusterIds))
          if (famErr) {
            // Best-effort: log and continue with empty family_kind map.
            // Embeddings still produce usable v2 vectors without the
            // type tag — the embedding loop logs signal coverage so
            // a sudden drop is detectable downstream.
            logServerError("admin-cluster", "family_kind_lookup_failed", famErr, {
              clusterCount: clusterIds.size,
            })
          } else {
            const kindByCluster = new Map<string, string>()
            for (const row of (famRows ?? []) as Array<{
              cluster_id: string
              family_kind: string | null
            }>) {
              if (row.family_kind && !kindByCluster.has(row.cluster_id)) {
                kindByCluster.set(row.cluster_id, row.family_kind)
              }
            }
            for (const [obsId, clusterId] of obsToCluster) {
              const kind = kindByCluster.get(clusterId)
              if (kind) familyKindById.set(obsId, kind)
            }
          }
        }
      }

      const semanticResult = await runSemanticClusteringForBatch(
        supabase,
        rows.map((row) => {
          const id = row.id as string
          return {
            id,
            title: ((row.title as string) ?? "").trim(),
            content: (row.content as string | null) ?? null,
            topicSlug: topicSlugById.get(id) ?? null,
            errorCode: errorCodeById.get(id) ?? null,
            topStackFrame: topStackFrameById.get(id) ?? null,
            platform: platformById.get(id) ?? null,
            familyKind: familyKindById.get(id) ?? null,
          }
        }),
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
      embeddingSignalCoverage = semanticResult.embeddingSignalCoverage
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
      // — v2 structured-signal coverage so a "low-signal" batch (which
      //   degrades to v1-equivalent prose-only embeddings) is detectable
      // Fields are null in title-hash mode (no embedding/similarity work).
      embeddingStats,
      embeddingSignalCoverage,
      semanticGroupsFormed,
      largestGroupSize,
      similarityHistogram,
      similarityThreshold,
      minClusterSize,
    })
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 })
}
