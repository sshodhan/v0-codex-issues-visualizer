import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { classifyClusterFamily } from "@/lib/storage/family-classification"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Admin endpoint for Family Classification backfill (Layer A interpretation).
//
// Classifies clusters into family_kind + optional LLM title/summary.
// This is NOT a clustering or labelling change — just a per-cluster
// interpretation layer that sits on top of `mv_cluster_topic_metadata`
// and optional manual review signals. See docs/CLUSTERING_DESIGN.md §4.7.
//
// Parallel to /api/admin/classify-backfill and
// /api/admin/cluster-label-backfill: same orchestrator shape, same
// admin secret gate (x-admin-secret header), same dryRun/apply flow.
//
// "Up-to-date" here means a row in `family_classification_current`
// whose `algorithm_version` equals
// `CURRENT_VERSIONS.family_classification`. After a version bump, all
// older-version clusters re-appear as candidates.

export const maxDuration = 300

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const PENDING_DEFAULT_LIMIT = 20
const PENDING_MAX_LIMIT = 100
const CURRENT_FAMILY_VERSION = CURRENT_VERSIONS.family_classification

interface PendingCluster {
  cluster_id: string
  observation_count: number
  dominant_topic_slug: string | null
  classification_coverage_share: number
  mixed_topic_score: number
  cluster_path: string
}

interface BackfillStats {
  total_clusters: number | null
  without_classification: number | null
  /** Count of current-version family_classifications whose cluster has
   *  no active members (cluster_members.detached_at IS NULL). These are
   *  orphans left behind by a prior cluster rebuild with redetach. The
   *  classifications were valid when written but now point to a dead
   *  cluster shape — operators should treat them as "needs re-classify
   *  on the new shape." */
  stale_classifications: number | null
  algorithm_version: string
  pending?: PendingCluster[]
}

interface BackfillResult {
  dryRun: boolean
  candidates: number
  classified: number
  failed: number
  wouldProcess: number
}

// GET: stats on how many clusters need a current-version classification.
//
// "without_classification" counts clusters whose latest row in
// `family_classification_current` is NOT at the current algorithm
// version (or is missing entirely). After a version bump this stat
// surfaces all stale clusters as work to do, not just the
// never-classified ones.
//
// Optional `?pending=N` (default 20, max 100) additionally returns up to
// N pending clusters (largest by observation_count first), with the
// metadata the panel needs to render a per-row "Classify" button. This
// powers the "step through the backlog one cluster at a time" workflow
// when batch classification can't fit inside Vercel's gateway timeout.
export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const url = new URL(request.url)
  const pendingParam = url.searchParams.get("pending")
  const pendingLimit =
    pendingParam !== null
      ? Math.max(
          1,
          Math.min(
            Number.parseInt(pendingParam, 10) || PENDING_DEFAULT_LIMIT,
            PENDING_MAX_LIMIT,
          ),
        )
      : null

  const supabase = createAdminClient()
  try {
    const { count: totalClusters, error: totalErr } = await supabase
      .from("clusters")
      .select("id", { count: "exact", head: true })

    // family_classification_current is one row per cluster (latest by
    // computed_at). Count rows at the active version → "up to date".
    const { count: atCurrentVersion, error: currentErr } = await supabase
      .from("family_classification_current")
      .select("cluster_id", { count: "exact", head: true })
      .eq("algorithm_version", CURRENT_FAMILY_VERSION)

    // Count classifications that point to dead clusters. Two queries
    // because PostgREST has no anti-join helper:
    //   1. cluster_ids that currently have at least one active member
    //   2. classification cluster_ids NOT in (1)
    // Used as a partial-algorithm signal: after a cluster rebuild with
    // redetach the old `family_classifications` rows reference clusters
    // that no longer have members. The number lets operators see "I
    // need to re-classify N clusters because the upstream cluster shape
    // moved on."
    const { data: aliveMv, error: aliveErr } = await supabase
      .from("mv_cluster_topic_metadata")
      .select("cluster_id")
      .gt("observation_count", 0)
    const { data: classifiedRows, error: classifiedErr } = await supabase
      .from("family_classification_current")
      .select("cluster_id, algorithm_version")
      .eq("algorithm_version", CURRENT_FAMILY_VERSION)

    if (totalErr) {
      logServerError("admin-family-classification", "count_total_failed", totalErr)
    }
    if (currentErr) {
      logServerError("admin-family-classification", "count_current_failed", currentErr)
    }
    if (aliveErr) {
      logServerError("admin-family-classification", "count_alive_failed", aliveErr)
    }
    if (classifiedErr) {
      logServerError("admin-family-classification", "count_classified_failed", classifiedErr)
    }

    const total = totalClusters ?? null
    const without =
      total != null && atCurrentVersion != null
        ? Math.max(0, total - atCurrentVersion)
        : null

    let stale: number | null = null
    if (aliveMv && classifiedRows) {
      const aliveSet = new Set(
        (aliveMv as Array<{ cluster_id: string }>).map((r) => r.cluster_id),
      )
      stale = (classifiedRows as Array<{ cluster_id: string }>).filter(
        (r) => !aliveSet.has(r.cluster_id),
      ).length
    }

    const response: BackfillStats = {
      total_clusters: total,
      without_classification: without,
      stale_classifications: stale,
      algorithm_version: CURRENT_FAMILY_VERSION,
    }

    if (pendingLimit != null) {
      // Same shape as the POST batch path: list cluster_ids already at
      // the current version, then rank by observation_count from the
      // topic-metadata MV and filter out the up-to-date ones.
      const { data: currentRows, error: currentListErr } = await supabase
        .from("family_classification_current")
        .select("cluster_id, algorithm_version")
        .eq("algorithm_version", CURRENT_FAMILY_VERSION)

      if (currentListErr) {
        logServerError(
          "admin-family-classification",
          "pending_current_list_failed",
          currentListErr,
        )
      }

      const upToDate = new Set(
        (currentRows ?? []).map((c: { cluster_id: string }) => c.cluster_id),
      )

      const { data: ranked, error: rankedErr } = await supabase
        .from("mv_cluster_topic_metadata")
        .select(
          "cluster_id, observation_count, dominant_topic_slug, classification_coverage_share, mixed_topic_score, cluster_path",
        )
        // Skip dead clusters (observation_count = 0). They appear in the
        // MV after a redetach + rebuild because the row is keyed by
        // cluster_id; classifying them produces a junk low_evidence row
        // that points to nothing.
        .gt("observation_count", 0)
        .order("observation_count", { ascending: false })
        .limit(pendingLimit * 4)

      if (rankedErr) {
        logServerError(
          "admin-family-classification",
          "pending_ranked_list_failed",
          rankedErr,
        )
      }

      response.pending = (ranked ?? [])
        .filter((c: { cluster_id: string }) => !upToDate.has(c.cluster_id))
        .slice(0, pendingLimit)
        .map((c: {
          cluster_id: string
          observation_count: number | null
          dominant_topic_slug: string | null
          classification_coverage_share: number | string | null
          mixed_topic_score: number | string | null
          cluster_path: string | null
        }) => ({
          cluster_id: c.cluster_id,
          observation_count: c.observation_count ?? 0,
          dominant_topic_slug: c.dominant_topic_slug ?? null,
          classification_coverage_share: Number(c.classification_coverage_share ?? 0),
          mixed_topic_score: Number(c.mixed_topic_score ?? 0),
          cluster_path: c.cluster_path ?? "semantic",
        }))
    }

    return NextResponse.json(response)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("admin-family-classification", "get_stats_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST: run classification on one or more clusters.
export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  let body: {
    clusterId?: string
    limit?: number
    dryRun?: boolean
  } = {}
  try {
    body = await request.json()
  } catch {
    // Empty body is fine — defaults apply.
  }

  const dryRun = body.dryRun === true
  const limitRaw = Number(body.limit ?? DEFAULT_LIMIT)
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, MAX_LIMIT))

  const supabase = createAdminClient()

  // If clusterId is provided, classify just that one.
  if (body.clusterId) {
    logServer({
      component: "admin-family-classification",
      event: "single_cluster_started",
      level: "info",
      data: { cluster_id: body.clusterId, dryRun },
    })

    try {
      const draft = await classifyClusterFamily(supabase, body.clusterId)
      if (!draft) {
        return NextResponse.json(
          { error: "Failed to classify cluster" },
          { status: 500 },
        )
      }

      if (!dryRun) {
        const { error: insertErr } = await supabase
          .from("family_classifications")
          .insert({
            cluster_id: draft.cluster_id,
            algorithm_version: draft.algorithm_version,
            family_title: draft.family_title,
            family_summary: draft.family_summary,
            family_kind: draft.family_kind,
            dominant_topic_slug: draft.dominant_topic_slug,
            primary_failure_mode: draft.primary_failure_mode,
            affected_surface: draft.affected_surface,
            likely_owner_area: draft.likely_owner_area,
            severity_rollup: draft.severity_rollup,
            confidence: draft.confidence,
            needs_human_review: draft.needs_human_review,
            review_reasons: draft.review_reasons,
            evidence: draft.evidence,
          })

        if (insertErr) {
          logServerError("admin-family-classification", "insert_failed", insertErr, {
            cluster_id: body.clusterId,
          })
          return NextResponse.json(
            { error: "Failed to write classification" },
            { status: 500 },
          )
        }
      }

      logServer({
        component: "admin-family-classification",
        event: "single_cluster_succeeded",
        level: "info",
        data: {
          cluster_id: body.clusterId,
          family_kind: draft.family_kind,
          needs_human_review: draft.needs_human_review,
          confidence: draft.confidence,
          dryRun,
        },
      })

      return NextResponse.json({
        dryRun,
        classified: dryRun ? 0 : 1,
        draft,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logServerError("admin-family-classification", "single_cluster_failed", error, {
        cluster_id: body.clusterId,
      })
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // Otherwise, classify the top-N largest clusters that don't have a
  // current-version family_classification. "Largest" = observation_count
  // from the topic-metadata MV, so the human-review backlog gets the
  // highest-impact clusters first.
  try {
    // Cluster_ids whose latest classification is already at the active version.
    const { data: currentRows, error: currentErr } = await supabase
      .from("family_classification_current")
      .select("cluster_id, algorithm_version")
      .eq("algorithm_version", CURRENT_FAMILY_VERSION)

    if (currentErr) {
      logServerError("admin-family-classification", "current_list_failed", currentErr)
      return NextResponse.json(
        { error: "Failed to list current-version classifications" },
        { status: 500 },
      )
    }

    const upToDate = new Set(
      (currentRows ?? []).map((c: { cluster_id: string }) => c.cluster_id),
    )

    // Order by observation_count desc so the largest unclassified
    // clusters are processed first (matches the comment-stated intent).
    // Skip dead clusters (observation_count = 0); see GET-handler comment
    // — classifying them produces a junk low_evidence row.
    const { data: ranked, error: rankedErr } = await supabase
      .from("mv_cluster_topic_metadata")
      .select("cluster_id, observation_count")
      .gt("observation_count", 0)
      .order("observation_count", { ascending: false })
      .limit(limit * 4) // generous so post-filter still has `limit` rows

    if (rankedErr) {
      logServerError("admin-family-classification", "ranked_list_failed", rankedErr)
      return NextResponse.json(
        { error: "Failed to list ranked clusters" },
        { status: 500 },
      )
    }

    const clusterIds = (ranked ?? [])
      .filter((c: { cluster_id: string }) => !upToDate.has(c.cluster_id))
      .slice(0, limit)
      .map((c: { cluster_id: string }) => c.cluster_id)
    const wouldProcess = clusterIds.length

    if (dryRun) {
      logServer({
        component: "admin-family-classification",
        event: "backfill_dryrun",
        level: "info",
        data: { candidates: wouldProcess, limit },
      })
      return NextResponse.json({
        dryRun: true,
        candidates: wouldProcess,
        classified: 0,
        failed: 0,
        wouldProcess,
      } as BackfillResult)
    }

    // Apply: classify each and write.
    let classifiedCount = 0
    let failed = 0
    const failedIds: string[] = []

    for (const clusterId of clusterIds) {
      try {
        const draft = await classifyClusterFamily(supabase, clusterId)
        if (!draft) {
          failed++
          failedIds.push(clusterId)
          continue
        }

        const { error: insertErr } = await supabase
          .from("family_classifications")
          .insert({
            cluster_id: draft.cluster_id,
            algorithm_version: draft.algorithm_version,
            family_title: draft.family_title,
            family_summary: draft.family_summary,
            family_kind: draft.family_kind,
            dominant_topic_slug: draft.dominant_topic_slug,
            primary_failure_mode: draft.primary_failure_mode,
            affected_surface: draft.affected_surface,
            likely_owner_area: draft.likely_owner_area,
            severity_rollup: draft.severity_rollup,
            confidence: draft.confidence,
            needs_human_review: draft.needs_human_review,
            review_reasons: draft.review_reasons,
            evidence: draft.evidence,
          })

        if (insertErr) {
          failed++
          failedIds.push(clusterId)
        } else {
          classifiedCount++
        }
      } catch (error) {
        failed++
        failedIds.push(clusterId)
        logServerError("admin-family-classification", "item_failed", error, {
          cluster_id: clusterId,
        })
      }
    }

    logServer({
      component: "admin-family-classification",
      event: "backfill_applied",
      level: "info",
      data: {
        candidates: wouldProcess,
        classified: classifiedCount,
        failed,
        failed_ids: failedIds.slice(0, 10),
      },
    })

    return NextResponse.json({
      dryRun: false,
      candidates: wouldProcess,
      classified: classifiedCount,
      failed,
      wouldProcess,
    } as BackfillResult)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("admin-family-classification", "backfill_failed", error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
