import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { logServerError } from "@/lib/error-tracking/server-logger"

// Returns classifications joined with the most recent matching
// classification_reviews row so the queue reflects effective (post-review)
// state. Baseline and latest review are both included in the payload so
// the UI can show the reviewer override delta if it wants.
// See docs/ARCHITECTURE.md v10 §§3.3, 5.2.
//
// When ?as_of=<ISO8601> is supplied, only returns reviews up to that
// timestamp for point-in-time replay.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  // Parse as_of parameter for point-in-time replay
  const asOfRaw = searchParams.get("as_of")
  let asOf: Date | null = null
  if (asOfRaw) {
    const parsed = new Date(asOfRaw)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        {
          error: "Invalid as_of",
          message: "as_of must be a valid ISO8601 timestamp",
        },
        { status: 400 },
      )
    }
    if (parsed.getTime() > Date.now() + 60_000) {
      return NextResponse.json(
        {
          error: "Invalid as_of",
          message: "as_of cannot be in the future",
        },
        { status: 400 },
      )
    }
    asOf = parsed
  }

  const status = searchParams.get("status")
  const category = searchParams.get("category")
  const needsHumanReview = searchParams.get("needs_human_review")
  const limit = Number.parseInt(searchParams.get("limit") || "50", 10)

  let query = supabase
    .from("classifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)

  // In as_of mode, only return classifications created before that timestamp
  if (asOf) {
    query = query.lte("created_at", asOf.toISOString())
  }

  // Baseline filters (reviewer overrides are applied in-memory below so the
  // filter can still find rows whose reviewed status differs from baseline).
  if (status) query = query.eq("status", status)
  if (category) query = query.eq("category", category)
  if (needsHumanReview === "true") query = query.eq("needs_human_review", true)
  if (needsHumanReview === "false") query = query.eq("needs_human_review", false)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = data || []
  if (rows.length === 0) {
    return NextResponse.json({ data: [] })
  }

  // Gather related reviews and observation traceability data in parallel.
  const classificationIds = rows.map((r: any) => r.id)
  const observationIds = rows
    .map((r: any) => r.observation_id)
    .filter((v: string | null): v is string => Boolean(v))

  // Build review query, filtering by as_of if present
  let reviewQuery = supabase
    .from("classification_reviews")
    .select("*")
    .in("classification_id", classificationIds)
    .order("reviewed_at", { ascending: false })
  if (asOf) {
    reviewQuery = reviewQuery.lte("reviewed_at", asOf.toISOString())
  }

  const [{ data: reviews }, { data: observationRows }] = await Promise.all([
    reviewQuery,
    observationIds.length
      ? supabase
          .from("mv_observation_current")
          .select(
            "observation_id, title, url, sentiment, cluster_id, cluster_key, frequency_count",
          )
          .in("observation_id", observationIds)
      : Promise.resolve({ data: [] as any[] }),
  ])

  // Second-stage cluster fetch: only labels + confidence. Active member
  // count (`cluster_size`) comes from `mv_observation_current.frequency_count`
  // above (backed by the `cluster_frequency` view in scripts/007; already
  // counts members where detached_at IS NULL) — a separate `cluster_members`
  // round-trip would duplicate that work. Kept out of the first Promise.all
  // because the cluster id set is not known until `observationRows` resolves.
  const clusterIds = Array.from(
    new Set(
      (observationRows || [])
        .map((o: any) => o.cluster_id)
        .filter((v: string | null): v is string => Boolean(v)),
    ),
  )
  const { data: clusterRows, error: clusterError } = clusterIds.length
    ? await supabase
        .from("clusters")
        .select("id, cluster_key, label, label_confidence")
        .in("id", clusterIds)
    : { data: [] as any[], error: null }

  if (clusterError) {
    // Cluster enrichment failure is non-fatal — the rest of the response
    // (classifications, reviews, observation traceability) is still useful,
    // so degrade to null cluster fields rather than 500 the whole queue.
    // Log to the server error channel so monitoring catches it.
    logServerError(
      "api-classifications",
      "cluster_label_fetch_failed",
      clusterError,
      { cluster_id_count: clusterIds.length },
    )
  }

  const latestReviewByClassification = new Map<string, any>()
  for (const review of reviews || []) {
    if (!latestReviewByClassification.has(review.classification_id)) {
      latestReviewByClassification.set(review.classification_id, review)
    }
  }

  const observationMap = new Map<string, any>()
  for (const o of observationRows || []) {
    observationMap.set(o.observation_id, o)
  }

  const clusterMap = new Map<
    string,
    { label: string | null; label_confidence: number | null }
  >()
  for (const c of clusterRows || []) {
    clusterMap.set(c.id, {
      label: c.label ?? null,
      label_confidence: c.label_confidence ?? null,
    })
  }

  const withReviews = rows.map((row: any) => {
    const latest = latestReviewByClassification.get(row.id) ?? null
    const obs = row.observation_id ? observationMap.get(row.observation_id) ?? null : null
    const cluster = obs?.cluster_id ? clusterMap.get(obs.cluster_id) ?? null : null
    return {
      ...row,
      latest_review: latest,
      // Effective fields = review override when present, else baseline.
      effective_status: latest?.status ?? row.status,
      effective_category: latest?.category ?? row.category,
      effective_severity: latest?.severity ?? row.severity,
      effective_needs_human_review:
        latest?.needs_human_review ?? row.needs_human_review,
      // Traceability fields — sourced from the linked observation, not stored
      // redundantly on the classification. See docs/ARCHITECTURE.md v10 §7.2.
      source_issue_url: obs?.url ?? null,
      source_issue_title: obs?.title ?? null,
      source_issue_sentiment: obs?.sentiment ?? null,
      // Semantic-cluster identity carried from the observation's current
      // cluster membership. `cluster_key` (prefixed `semantic:` or `title:`)
      // is an internal identifier used by the chip-strip memo to hide
      // title-hash singletons — never render it in user-visible copy.
      // `cluster_size` is live (not filtered by `as_of`); clusters carry
      // no derivation timestamp so as-of replay is intentionally "now" here.
      cluster_id: obs?.cluster_id ?? null,
      cluster_key: obs?.cluster_key ?? null,
      cluster_label: cluster?.label ?? null,
      cluster_label_confidence: cluster?.label_confidence ?? null,
      cluster_size: obs?.cluster_id ? Number(obs?.frequency_count ?? 0) : null,
    }
  })

  return NextResponse.json({
    data: withReviews,
    asOf: asOf ? asOf.toISOString() : null,
  })
}
