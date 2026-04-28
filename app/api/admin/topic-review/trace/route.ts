import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { logServerError } from "@/lib/error-tracking/server-logger"

// GET /api/admin/topic-review/trace
//
// Two query modes:
//   * ?observationId=<uuid>  — return the full topic-trace payload for
//     that observation (current assignment, evidence, cluster metadata
//     when available, recent review events).
//   * ?titleQuery=<substring>[&clusterId=<uuid>][&limit=N] — return up
//     to N matching observations as a search result list (no evidence,
//     just enough to pick one to inspect).
//
// Read-only — never writes. Cluster topic metadata (mv_cluster_topic_metadata)
// is OPTIONAL: a missing MV returns `clusterTopicMetadata: null`, never a
// 500. Same for `categories` when the join is empty on pre-v5 rows.

export const maxDuration = 30
const DEFAULT_SEARCH_LIMIT = 25
const MAX_SEARCH_LIMIT = 100

interface CategoryAssignmentRow {
  id: string
  algorithm_version: string | null
  category_id: string | null
  confidence: number | null
  evidence: unknown
  computed_at: string | null
  categories: { slug: string } | null
}

interface ObservationCurrentRow {
  observation_id: string
  source_id: string | null
  external_id: string | null
  title: string | null
  content: string | null
  url: string | null
  author: string | null
  published_at: string | null
  captured_at: string | null
  cluster_id: string | null
  cluster_key: string | null
  category_id: string | null
}

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const url = new URL(request.url)
  const observationId = url.searchParams.get("observationId")?.trim() || null
  const titleQuery = url.searchParams.get("titleQuery")?.trim() || null
  const clusterIdFilter = url.searchParams.get("clusterId")?.trim() || null
  const limitRaw = Number(url.searchParams.get("limit"))
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(limitRaw, MAX_SEARCH_LIMIT))
    : DEFAULT_SEARCH_LIMIT

  const supabase = createAdminClient()

  // ---- Search mode -----------------------------------------------------
  if (!observationId) {
    if (!titleQuery && !clusterIdFilter) {
      return NextResponse.json(
        {
          error:
            "Provide observationId, titleQuery, or clusterId to search.",
        },
        { status: 400 },
      )
    }
    let q = supabase
      .from("mv_observation_current")
      .select(
        "observation_id, title, cluster_id, cluster_key, category_id, captured_at",
      )
      .order("captured_at", { ascending: false })
      .limit(limit)
    if (titleQuery) q = q.ilike("title", `%${titleQuery}%`)
    if (clusterIdFilter) q = q.eq("cluster_id", clusterIdFilter)
    const res = await q
    if (res.error) {
      logServerError("admin-topic-review", "trace_search_failed", res.error, {
        titleQuery,
        clusterId: clusterIdFilter,
        limit,
      })
      return NextResponse.json(
        { error: "Search failed", detail: res.error.message },
        { status: 500 },
      )
    }
    return NextResponse.json({
      mode: "search",
      query: { titleQuery, clusterId: clusterIdFilter, limit },
      results: res.data ?? [],
    })
  }

  // ---- Single-observation trace mode ----------------------------------
  const obsRes = await supabase
    .from("mv_observation_current")
    .select(
      "observation_id, source_id, external_id, title, content, url, author, published_at, captured_at, cluster_id, cluster_key, category_id",
    )
    .eq("observation_id", observationId)
    .maybeSingle<ObservationCurrentRow>()

  if (obsRes.error) {
    logServerError("admin-topic-review", "trace_observation_lookup_failed", obsRes.error, {
      observationId,
    })
    return NextResponse.json(
      { error: "Observation lookup failed", detail: obsRes.error.message },
      { status: 500 },
    )
  }
  if (!obsRes.data) {
    return NextResponse.json(
      { error: "Observation not found" },
      { status: 404 },
    )
  }
  const observation = obsRes.data

  // ---- Latest deterministic + manual category assignments. We return
  //      both the most-recent row (winner on read) and the most-recent
  //      DETERMINISTIC row so the panel can show "manual override on top
  //      of v6 saying X" without an extra round-trip.
  const assignmentsRes = await supabase
    .from("category_assignments")
    .select(
      "id, algorithm_version, category_id, confidence, evidence, computed_at, categories:category_id(slug)",
    )
    .eq("observation_id", observationId)
    .order("computed_at", { ascending: false })
    .limit(10)

  if (assignmentsRes.error) {
    logServerError(
      "admin-topic-review",
      "trace_assignments_lookup_failed",
      assignmentsRes.error,
      { observationId },
    )
    return NextResponse.json(
      {
        error: "Category assignment lookup failed",
        detail: assignmentsRes.error.message,
      },
      { status: 500 },
    )
  }
  const assignments =
    (assignmentsRes.data ?? []) as unknown as CategoryAssignmentRow[]
  const currentAssignment = assignments[0] ?? null
  const latestDeterministic =
    assignments.find((a) => a.algorithm_version !== "manual") ?? null

  // ---- Manual override history. Always returns every manual override
  //      row for the observation, NOT just the currently-effective one.
  //      Per docs/SCORING.md §11.5, a future Stage-1 backfill can
  //      supersede a manual override by writing a fresher deterministic
  //      row; the override row itself is preserved permanently and the
  //      reviewer needs to see it on the trace panel even when no
  //      longer effective. Each row is flagged `is_currently_effective`
  //      so the UI can render an "active" vs "superseded" badge.
  const manualHistoryRes = await supabase
    .from("category_assignments")
    .select(
      "id, algorithm_version, category_id, confidence, evidence, computed_at, categories:category_id(slug)",
    )
    .eq("observation_id", observationId)
    .eq("algorithm_version", "manual")
    .order("computed_at", { ascending: false })
    .limit(50)
  if (manualHistoryRes.error) {
    // Best-effort; the rest of the trace is still useful even if the
    // history lookup fails. Log so operators can see drift in Vercel
    // logs rather than silently rendering an empty history alert.
    logServerError(
      "admin-topic-review",
      "trace_manual_history_lookup_failed",
      manualHistoryRes.error,
      { observationId },
    )
  }
  const manualHistoryRows =
    (manualHistoryRes.data ?? []) as unknown as CategoryAssignmentRow[]
  const manualOverrideHistory = manualHistoryRows.map((row) => ({
    id: row.id,
    algorithm_version: row.algorithm_version,
    slug: row.categories?.slug ?? null,
    category_id: row.category_id,
    confidence: row.confidence,
    evidence: row.evidence,
    computed_at: row.computed_at,
    is_currently_effective: currentAssignment?.id === row.id,
  }))

  // ---- Cluster lookup (label, family). Best-effort.
  let cluster: {
    id: string | null
    cluster_key: string | null
    label: string | null
    label_model: string | null
    label_confidence: number | null
  } | null = null
  if (observation.cluster_id) {
    const clusterRes = await supabase
      .from("clusters")
      .select("id, cluster_key, label, label_model, label_confidence")
      .eq("id", observation.cluster_id)
      .maybeSingle()
    if (clusterRes.error) {
      // Best-effort; the rest of the trace is still useful. A real error
      // here usually means a stale cluster_id reference and is worth
      // surfacing in Vercel logs.
      logServerError(
        "admin-topic-review",
        "trace_cluster_lookup_failed",
        clusterRes.error,
        { observationId, clusterId: observation.cluster_id },
      )
    } else if (clusterRes.data) {
      cluster = clusterRes.data as typeof cluster
    }
  }

  // ---- Cluster topic metadata (Layer A) — OPTIONAL.
  //      mv_cluster_topic_metadata may not exist in this environment;
  //      treat any error as "feature unavailable" rather than a 500.
  //      We do NOT log the error: the MV is genuinely optional and a
  //      missing-relation error is the expected shape on installs that
  //      haven't applied scripts/028. Logging would create noise on
  //      every trace request.
  let clusterTopicMetadata: unknown = null
  if (observation.cluster_id) {
    const mvRes = await supabase
      .from("mv_cluster_topic_metadata")
      .select(
        "topic_distribution, dominant_topic_slug, dominant_topic_share, mixed_topic_score, classification_coverage_share, common_matched_phrases",
      )
      .eq("cluster_id", observation.cluster_id)
      .maybeSingle()
    if (!mvRes.error && mvRes.data) {
      clusterTopicMetadata = mvRes.data
    }
  }

  // ---- Recent review events for this observation.
  const reviewEventsRes = await supabase
    .from("topic_review_events")
    .select(
      "id, created_at, reviewer, original_topic_slug, corrected_topic_slug, reason_code, suggested_layer, suggested_action, phrase_candidate, rationale, status",
    )
    .eq("observation_id", observationId)
    .order("created_at", { ascending: false })
    .limit(50)
  if (reviewEventsRes.error) {
    logServerError(
      "admin-topic-review",
      "trace_review_events_lookup_failed",
      reviewEventsRes.error,
      { observationId },
    )
  }

  return NextResponse.json({
    mode: "trace",
    observation: {
      observation_id: observation.observation_id,
      title: observation.title,
      content: observation.content,
      url: observation.url,
      source_id: observation.source_id,
      external_id: observation.external_id,
      published_at: observation.published_at,
      captured_at: observation.captured_at,
      cluster_id: observation.cluster_id,
      cluster_key: observation.cluster_key,
    },
    currentAssignment: currentAssignment
      ? {
          id: currentAssignment.id,
          algorithm_version: currentAssignment.algorithm_version,
          slug: currentAssignment.categories?.slug ?? null,
          category_id: currentAssignment.category_id,
          confidence: currentAssignment.confidence,
          evidence: currentAssignment.evidence,
          computed_at: currentAssignment.computed_at,
        }
      : null,
    latestDeterministic: latestDeterministic
      ? {
          id: latestDeterministic.id,
          algorithm_version: latestDeterministic.algorithm_version,
          slug: latestDeterministic.categories?.slug ?? null,
          category_id: latestDeterministic.category_id,
          confidence: latestDeterministic.confidence,
          evidence: latestDeterministic.evidence,
          computed_at: latestDeterministic.computed_at,
        }
      : null,
    cluster,
    clusterTopicMetadata,
    manualOverrideHistory,
    reviewEvents: reviewEventsRes.data ?? [],
    generated_at: new Date().toISOString(),
  })
}
