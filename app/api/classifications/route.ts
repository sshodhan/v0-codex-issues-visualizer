import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Returns classifications joined with the most recent matching
// classification_reviews row so the queue reflects effective (post-review)
// state. Baseline and latest review are both included in the payload so
// the UI can show the reviewer override delta if it wants.
// See docs/ARCHITECTURE.md v10 §§3.3, 5.2.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  const status = searchParams.get("status")
  const category = searchParams.get("category")
  const needsHumanReview = searchParams.get("needs_human_review")
  const limit = Number.parseInt(searchParams.get("limit") || "50", 10)

  let query = supabase
    .from("classifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)

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

  const [{ data: reviews }, { data: observationRows }] = await Promise.all([
    supabase
      .from("classification_reviews")
      .select("*")
      .in("classification_id", classificationIds)
      .order("reviewed_at", { ascending: false }),
    observationIds.length
      ? supabase
          .from("mv_observation_current")
          .select("observation_id, title, url, sentiment")
          .in("observation_id", observationIds)
      : Promise.resolve({ data: [] as any[] }),
  ])

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

  const withReviews = rows.map((row: any) => {
    const latest = latestReviewByClassification.get(row.id) ?? null
    const obs = row.observation_id ? observationMap.get(row.observation_id) ?? null : null
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
    }
  })

  return NextResponse.json({ data: withReviews })
}
