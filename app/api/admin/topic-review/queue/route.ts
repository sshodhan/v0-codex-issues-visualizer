import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { isReviewStatus } from "@/lib/admin/topic-review"
import { logServerError } from "@/lib/error-tracking/server-logger"

// GET /api/admin/topic-review/queue
//
// Builds a review queue from the latest deterministic category_assignments
// rows. The base scan reads category_assignments + observations + categories
// directly (vs. mv_observation_current) so we get the structured evidence
// JSONB without depending on the MV's column projection. Manual override
// rows are excluded — the queue is driven by what the CLASSIFIER said.
//
// Filters (all optional, AND-combined):
//   * topic — slug filter (e.g. "other")
//   * marginMax — keep rows where evidence.scoring.margin <= N
//   * confidenceMax — keep rows where confidence (= confidenceProxy) <= N
//   * algorithmVersion — exact match (e.g. "v6")
//   * clusterId — exact cluster_id match (joins via observations.cluster_id
//     through mv_observation_current for canonical cluster lookup)
//   * dominantTopicSlug — when mv_cluster_topic_metadata exists, filter
//     to rows whose cluster has this dominant topic
//   * reviewStatus — only show rows whose latest topic_review_events row
//     has this status; "none" → only rows with NO review event
//   * limit — default 50, max 200

export const maxDuration = 30
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

interface AssignmentRow {
  id: string
  observation_id: string
  algorithm_version: string | null
  category_id: string | null
  confidence: number | null
  evidence: {
    scoring?: {
      margin?: number
      runner_up?: string | null
      winner?: string
    }
  } | null
  computed_at: string | null
  categories: { slug: string } | null
}

interface ObservationLite {
  observation_id: string
  title: string | null
  cluster_id: string | null
  cluster_key: string | null
}

interface ClusterTopicMetaRow {
  cluster_id: string
  dominant_topic_slug: string | null
  dominant_topic_share: number | null
}

interface ReviewEventRow {
  observation_id: string
  status: string
  created_at: string
}

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const url = new URL(request.url)
  const topic = url.searchParams.get("topic")?.trim() || null
  const marginMaxRaw = url.searchParams.get("marginMax")
  const confidenceMaxRaw = url.searchParams.get("confidenceMax")
  const algorithmVersion =
    url.searchParams.get("algorithmVersion")?.trim() || null
  const clusterId = url.searchParams.get("clusterId")?.trim() || null
  const dominantTopicSlug =
    url.searchParams.get("dominantTopicSlug")?.trim() || null
  const reviewStatus = url.searchParams.get("reviewStatus")?.trim() || null
  const limitRaw = Number(url.searchParams.get("limit"))
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(limitRaw, MAX_LIMIT))
    : DEFAULT_LIMIT

  const marginMax = marginMaxRaw !== null ? Number(marginMaxRaw) : null
  const confidenceMax =
    confidenceMaxRaw !== null ? Number(confidenceMaxRaw) : null

  if (reviewStatus && reviewStatus !== "none" && !isReviewStatus(reviewStatus)) {
    return NextResponse.json(
      { error: `Invalid reviewStatus: ${reviewStatus}` },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()

  // ---- Base assignment scan. Pull more than `limit` so the JS-side
  //      margin/confidence/clusterTopic filters don't starve the page.
  const SCAN_MULTIPLIER = 5
  const scanLimit = Math.min(limit * SCAN_MULTIPLIER, MAX_LIMIT * 2)
  let q = supabase
    .from("category_assignments")
    .select(
      "id, observation_id, algorithm_version, category_id, confidence, evidence, computed_at, categories:category_id(slug)",
    )
    .neq("algorithm_version", "manual")
    .order("computed_at", { ascending: false })
    .limit(scanLimit)
  if (algorithmVersion) q = q.eq("algorithm_version", algorithmVersion)
  if (confidenceMax !== null && Number.isFinite(confidenceMax))
    q = q.lte("confidence", confidenceMax)

  const assignmentsRes = await q
  if (assignmentsRes.error) {
    logServerError(
      "admin-topic-review",
      "queue_scan_failed",
      assignmentsRes.error,
      {
        topic,
        marginMax,
        confidenceMax,
        algorithmVersion,
        clusterId,
        dominantTopicSlug,
        reviewStatus,
        limit,
      },
    )
    return NextResponse.json(
      { error: "Queue scan failed", detail: assignmentsRes.error.message },
      { status: 500 },
    )
  }
  const assignments =
    (assignmentsRes.data ?? []) as unknown as AssignmentRow[]

  // De-dupe to "latest deterministic per observation".
  const latestByObs = new Map<string, AssignmentRow>()
  for (const row of assignments) {
    if (!latestByObs.has(row.observation_id)) {
      latestByObs.set(row.observation_id, row)
    }
  }
  let candidates = Array.from(latestByObs.values())

  if (topic) candidates = candidates.filter((r) => r.categories?.slug === topic)
  if (marginMax !== null && Number.isFinite(marginMax)) {
    candidates = candidates.filter((r) => {
      const m = r.evidence?.scoring?.margin
      return typeof m === "number" && m <= marginMax
    })
  }

  // ---- Enrich with observation title + cluster id/key.
  const obsIds = candidates.map((r) => r.observation_id)
  const obsById = new Map<string, ObservationLite>()
  if (obsIds.length > 0) {
    const obsRes = await supabase
      .from("mv_observation_current")
      .select("observation_id, title, cluster_id, cluster_key")
      .in("observation_id", obsIds)
    if (obsRes.error) {
      logServerError(
        "admin-topic-review",
        "queue_observation_lookup_failed",
        obsRes.error,
        { observationCount: obsIds.length },
      )
    } else if (obsRes.data) {
      for (const row of obsRes.data as ObservationLite[]) {
        obsById.set(row.observation_id, row)
      }
    }
  }

  if (clusterId) {
    candidates = candidates.filter(
      (r) => obsById.get(r.observation_id)?.cluster_id === clusterId,
    )
  }

  // ---- Optional cluster-topic-metadata enrichment + filter.
  const clusterIds = Array.from(
    new Set(
      candidates
        .map((r) => obsById.get(r.observation_id)?.cluster_id)
        .filter((id): id is string => Boolean(id)),
    ),
  )
  const clusterMetaById = new Map<string, ClusterTopicMetaRow>()
  let clusterMetadataAvailable = false
  if (clusterIds.length > 0) {
    const mvRes = await supabase
      .from("mv_cluster_topic_metadata")
      .select("cluster_id, dominant_topic_slug, dominant_topic_share")
      .in("cluster_id", clusterIds)
    if (!mvRes.error && mvRes.data) {
      clusterMetadataAvailable = true
      for (const row of mvRes.data as ClusterTopicMetaRow[]) {
        clusterMetaById.set(row.cluster_id, row)
      }
    }
  }

  if (dominantTopicSlug) {
    if (!clusterMetadataAvailable) {
      // Filter requested but the MV is unavailable in this env — return
      // an empty queue with a flag so the UI can explain it cleanly
      // rather than silently returning every row.
      return NextResponse.json({
        rows: [],
        total: 0,
        limit,
        clusterMetadataAvailable: false,
      })
    }
    candidates = candidates.filter((r) => {
      const cid = obsById.get(r.observation_id)?.cluster_id
      return cid ? clusterMetaById.get(cid)?.dominant_topic_slug === dominantTopicSlug : false
    })
  }

  // ---- Optional review-status filter (latest event per observation).
  let reviewStatusByObs = new Map<string, string>()
  if (reviewStatus) {
    const filterIds = candidates.map((r) => r.observation_id)
    if (filterIds.length > 0) {
      const evRes = await supabase
        .from("topic_review_events")
        .select("observation_id, status, created_at")
        .in("observation_id", filterIds)
        .order("created_at", { ascending: false })
      if (evRes.error) {
        logServerError(
          "admin-topic-review",
          "queue_review_status_lookup_failed",
          evRes.error,
          { reviewStatus, filterCount: filterIds.length },
        )
      } else if (evRes.data) {
        for (const row of evRes.data as ReviewEventRow[]) {
          if (!reviewStatusByObs.has(row.observation_id)) {
            reviewStatusByObs.set(row.observation_id, row.status)
          }
        }
      }
    }
    candidates = candidates.filter((r) => {
      const status = reviewStatusByObs.get(r.observation_id)
      return reviewStatus === "none"
        ? status === undefined
        : status === reviewStatus
    })
  }

  candidates = candidates.slice(0, limit)

  const rows = candidates.map((r) => {
    const obs = obsById.get(r.observation_id)
    const meta = obs?.cluster_id
      ? clusterMetaById.get(obs.cluster_id) ?? null
      : null
    return {
      observation_id: r.observation_id,
      title: obs?.title ?? null,
      current_topic: r.categories?.slug ?? null,
      algorithm_version: r.algorithm_version,
      confidence_proxy: r.confidence,
      margin: r.evidence?.scoring?.margin ?? null,
      runner_up: r.evidence?.scoring?.runner_up ?? null,
      cluster_id: obs?.cluster_id ?? null,
      cluster_key: obs?.cluster_key ?? null,
      dominant_cluster_topic: meta?.dominant_topic_slug ?? null,
      dominant_cluster_topic_share: meta?.dominant_topic_share ?? null,
      latest_review_status: reviewStatusByObs.get(r.observation_id) ?? null,
      computed_at: r.computed_at,
    }
  })

  return NextResponse.json({
    rows,
    total: rows.length,
    limit,
    clusterMetadataAvailable,
  })
}
