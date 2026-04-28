import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { classifyClusterFamily } from "@/lib/storage/family-classification"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Admin endpoint for Family Classification backfill (Layer A interpretation).
//
// Classifies clusters into family_kind + optional LLM title/summary.
// This is NOT a clustering or labelling change — just a per-cluster
// interpretation layer that sits on top of `mv_cluster_topic_metadata`
// (PR #150) and optional manual review signals (PR #151). See
// docs/CLUSTERING_DESIGN.md §4.7.
//
// Parallel to /api/admin/classify-backfill and
// /api/admin/cluster-label-backfill: same orchestrator shape, same
// admin secret gate (x-admin-secret header), same dryRun/apply flow.

export const maxDuration = 300

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

interface BackfillStats {
  total_clusters: number | null
  without_classification: number | null
}

interface BackfillResult {
  dryRun: boolean
  candidates: number
  classified: number
  failed: number
  wouldProcess: number
}

// GET: stats on how many clusters don't have a family classification yet.
export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const supabase = createAdminClient()
  try {
    // Count total clusters.
    const { count: totalClusters, error: totalErr } = await supabase
      .from("clusters")
      .select("id", { count: "exact", head: true })

    // Count clusters that have a family_classification row.
    const { count: withClassification, error: withErr } = await supabase
      .from("family_classifications")
      .select("cluster_id", { count: "exact", head: true })
      .distinct()

    if (totalErr) {
      logServerError("admin-family-classification", "count_total_failed", totalErr)
    }
    if (withErr) {
      logServerError("admin-family-classification", "count_with_failed", withErr)
    }

    const total = totalClusters ?? null
    const without =
      total != null && withClassification != null
        ? Math.max(0, total - withClassification)
        : null

    return NextResponse.json({
      total_clusters: total,
      without_classification: without,
    } as BackfillStats)
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

  // Otherwise, classify top clusters by observation count (without an existing classification).
  try {
    // First, get clusters that already have classifications.
    const { data: classified, error: classifiedErr } = await supabase
      .from("family_classifications")
      .select("cluster_id", { count: "exact", head: false })
      .distinct()

    if (classifiedErr) {
      logServerError("admin-family-classification", "classified_list_failed", classifiedErr)
      return NextResponse.json(
        { error: "Failed to list classified clusters" },
        { status: 500 },
      )
    }

    const classifiedIds = new Set((classified ?? []).map((c: { cluster_id: string }) => c.cluster_id))

    // Find clusters without a family_classification, ordered by id.
    const { data: allClusters, error: allErr } = await supabase
      .from("clusters")
      .select("id")
      .order("id", { ascending: false })
      .limit(limit * 2) // Fetch more to account for filtering

    if (allErr) {
      logServerError("admin-family-classification", "cluster_list_failed", allErr)
      return NextResponse.json(
        { error: "Failed to list clusters" },
        { status: 500 },
      )
    }

    // Filter out already-classified clusters
    const candidates = (allClusters ?? [])
      .filter((c: { id: string }) => !classifiedIds.has(c.id))
      .slice(0, limit)

    const clusterIds = candidates.map((c: { id: string }) => c.id)
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
