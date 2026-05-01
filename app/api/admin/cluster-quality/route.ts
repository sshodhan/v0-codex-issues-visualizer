import { NextRequest, NextResponse } from "next/server"
import { requireAdminSecret } from "@/lib/admin/auth"
import { createAdminClient } from "@/lib/supabase/admin"
import { logServerError } from "@/lib/error-tracking/server-logger"
import {
  baselineToCsvRow,
  summarizeClusterQuality,
  type ClusterQualityRow,
} from "@/lib/cluster-quality/baseline-metrics"

const DEFAULT_DAYS = 30
const MAX_DAYS = 365

/**
 * Phase 3 cluster-quality baseline endpoint.
 *
 * Read-only by design. Joins five upstream sources to materialize the
 * per-cluster row shape `summarizeClusterQuality` consumes:
 *   1. `cluster_members` (active rows only)            — size_in_window
 *   2. `clusters`                                       — cluster_key
 *   3. `mv_cluster_topic_metadata`                      — dominant_topic_slug, mixed_topic_score
 *   4. `family_classification_current`                  — family_kind, has_family_review
 *   5. `family_classification_review_current`           — has_family_review, review_disagreement
 *   6. `classifications` (per cluster member)           — dominant LLM category/subcategory + share
 *
 * No table is mutated. Phase 3 is "no behavior change" — see
 * docs/CLASSIFICATION_EVOLUTION_PLAN.md §3.
 *
 * Query params:
 *   - `?days=N` (default 30, max 365, `0` = all-time): time-bound the
 *     observation set used to compute LLM-category dominance per cluster.
 *     Cluster sizes themselves use ALL active members regardless of
 *     `days` — a cluster that's been active for 90 days but only has
 *     observations in the last 7 still counts as multi-member.
 *   - `?format=csv` returns a single CSV row suitable for pasting into
 *     the plan doc's snapshot table. Default is JSON.
 */
export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const params = request.nextUrl.searchParams
  const daysRaw = Number.parseInt(params.get("days") ?? `${DEFAULT_DAYS}`, 10)
  const days = Number.isFinite(daysRaw) ? Math.max(0, Math.min(daysRaw, MAX_DAYS)) : DEFAULT_DAYS
  const format = params.get("format") === "csv" ? "csv" : "json"

  const supabase = createAdminClient()

  // ---- Step 1: enumerate active clusters via cluster_members + clusters ----
  // Active = at least one undetached membership. Inner-join with
  // clusters so cluster_members orphans (rare, but defensive) don't
  // make it into the report.
  const { data: memberRows, error: memberErr } = await supabase
    .from("cluster_members")
    .select("cluster_id, observation_id, clusters!inner(cluster_key)")
    .is("detached_at", null)
  if (memberErr) {
    return NextResponse.json({ error: memberErr.message }, { status: 500 })
  }

  // Aggregate to per-cluster size + cluster_key.
  const clusterMap = new Map<
    string,
    { cluster_id: string; cluster_key: string; observation_ids: string[] }
  >()
  for (const row of (memberRows ?? []) as unknown as Array<{
    cluster_id: string
    observation_id: string
    clusters: { cluster_key: string } | { cluster_key: string }[] | null
  }>) {
    const clusterRel = Array.isArray(row.clusters) ? row.clusters[0] : row.clusters
    const cluster_key = clusterRel?.cluster_key ?? ""
    const existing = clusterMap.get(row.cluster_id)
    if (existing) {
      existing.observation_ids.push(row.observation_id)
    } else {
      clusterMap.set(row.cluster_id, {
        cluster_id: row.cluster_id,
        cluster_key,
        observation_ids: [row.observation_id],
      })
    }
  }
  const clusterIds = Array.from(clusterMap.keys())

  // ---- Step 2: side-tables for Topic, family, family-review, LLM classifications ----
  const sinceIso = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null

  const [topicMetaRes, familyRes, familyReviewRes, classificationRes] = await Promise.all([
    clusterIds.length > 0
      ? supabase
          .from("mv_cluster_topic_metadata")
          .select("cluster_id, dominant_topic_slug, mixed_topic_score")
          .in("cluster_id", clusterIds)
      : Promise.resolve({ data: [] as Array<unknown>, error: null }),
    clusterIds.length > 0
      ? supabase
          .from("family_classification_current")
          .select("cluster_id, family_kind")
          .in("cluster_id", clusterIds)
      : Promise.resolve({ data: [] as Array<unknown>, error: null }),
    clusterIds.length > 0
      ? supabase
          .from("family_classification_review_current")
          .select("cluster_id, expected_family_kind, actual_family_kind")
          .in("cluster_id", clusterIds)
      : Promise.resolve({ data: [] as Array<unknown>, error: null }),
    // Per-observation LLM classifications, scoped to the time window
    // when ?days > 0. Used to compute dominant LLM category/subcategory
    // per cluster.
    (() => {
      let q = supabase
        .from("classifications")
        .select("observation_id, category, subcategory, created_at")
        .in("observation_id", Array.from(new Set(Array.from(clusterMap.values()).flatMap((c) => c.observation_ids))))
        .order("created_at", { ascending: false })
      if (sinceIso) q = q.gte("created_at", sinceIso)
      return q
    })(),
  ])

  // Best-effort: log errors and continue with partial enrichment.
  if (topicMetaRes.error) {
    logServerError("admin-cluster-quality", "topic_metadata_lookup_failed", topicMetaRes.error)
  }
  if (familyRes.error) {
    logServerError("admin-cluster-quality", "family_lookup_failed", familyRes.error)
  }
  if (familyReviewRes.error) {
    logServerError("admin-cluster-quality", "family_review_lookup_failed", familyReviewRes.error)
  }
  if (classificationRes.error) {
    logServerError(
      "admin-cluster-quality",
      "classifications_lookup_failed",
      classificationRes.error,
    )
  }

  // Per-cluster index of side-table data.
  const topicByCluster = new Map<string, { dominant_topic_slug: string | null; mixed_topic_score: number | null }>()
  for (const row of (topicMetaRes.data ?? []) as Array<{
    cluster_id: string
    dominant_topic_slug: string | null
    mixed_topic_score: number | string | null
  }>) {
    topicByCluster.set(row.cluster_id, {
      dominant_topic_slug: row.dominant_topic_slug,
      // PostgREST may return numeric as string; normalize to number or null.
      mixed_topic_score:
        row.mixed_topic_score == null
          ? null
          : typeof row.mixed_topic_score === "number"
            ? row.mixed_topic_score
            : Number(row.mixed_topic_score),
    })
  }

  const familyByCluster = new Map<string, string>()
  for (const row of (familyRes.data ?? []) as Array<{ cluster_id: string; family_kind: string | null }>) {
    if (row.family_kind) familyByCluster.set(row.cluster_id, row.family_kind)
  }

  const reviewByCluster = new Map<string, { has_review: true; disagreement: boolean }>()
  for (const row of (familyReviewRes.data ?? []) as Array<{
    cluster_id: string
    expected_family_kind: string | null
    actual_family_kind: string | null
  }>) {
    const disagreement =
      Boolean(row.expected_family_kind) &&
      Boolean(row.actual_family_kind) &&
      row.expected_family_kind !== row.actual_family_kind
    reviewByCluster.set(row.cluster_id, { has_review: true, disagreement })
  }

  // Latest-per-observation classification, then aggregate to per-cluster
  // dominance. classifications is keyed by observation_id and may have
  // multiple rows per observation across algorithm versions; the
  // `.order(created_at desc)` query above lets us take the first row
  // we see per observation_id as "latest".
  const latestClsByObs = new Map<string, { category: string | null; subcategory: string | null }>()
  for (const row of (classificationRes.data ?? []) as Array<{
    observation_id: string
    category: string | null
    subcategory: string | null
  }>) {
    if (!latestClsByObs.has(row.observation_id)) {
      latestClsByObs.set(row.observation_id, {
        category: row.category,
        subcategory: row.subcategory,
      })
    }
  }

  // ---- Step 3: build per-cluster ClusterQualityRow ----
  const rows: ClusterQualityRow[] = []
  for (const cluster of clusterMap.values()) {
    const topicMeta = topicByCluster.get(cluster.cluster_id)
    const familyKind = familyByCluster.get(cluster.cluster_id) ?? null
    const review = reviewByCluster.get(cluster.cluster_id)

    // Per-cluster category / subcategory dominance from latest
    // classifications across the cluster's members. Skip observations
    // with no classification — including them in the denominator would
    // make a half-classified cluster look "mixed" when it's really
    // just under-classified.
    const catCounts = new Map<string, number>()
    const subCounts = new Map<string, number>()
    let classifiedMembers = 0
    for (const obsId of cluster.observation_ids) {
      const cls = latestClsByObs.get(obsId)
      if (!cls) continue
      classifiedMembers++
      if (cls.category) catCounts.set(cls.category, (catCounts.get(cls.category) ?? 0) + 1)
      if (cls.subcategory) {
        subCounts.set(cls.subcategory, (subCounts.get(cls.subcategory) ?? 0) + 1)
      }
    }
    const [topCat, topCatCount] = pickDominant(catCounts)
    const [topSub, topSubCount] = pickDominant(subCounts)

    rows.push({
      cluster_id: cluster.cluster_id,
      cluster_key: cluster.cluster_key,
      size_in_window: cluster.observation_ids.length,
      dominant_topic_slug: topicMeta?.dominant_topic_slug ?? null,
      mixed_topic_score: topicMeta?.mixed_topic_score ?? null,
      dominant_llm_category: topCat,
      dominant_llm_category_share:
        classifiedMembers > 0 && topCatCount > 0 ? topCatCount / classifiedMembers : null,
      dominant_llm_subcategory: topSub,
      dominant_llm_subcategory_share:
        classifiedMembers > 0 && topSubCount > 0 ? topSubCount / classifiedMembers : null,
      family_kind: familyKind,
      has_family_review: review?.has_review ?? false,
      review_disagreement: review?.disagreement ?? null,
    })
  }

  const baseline = summarizeClusterQuality(rows)

  if (format === "csv") {
    const today = new Date().toISOString().slice(0, 10)
    const header = "date,total_clusters,singleton_rate,coherent_cluster_rate,mixed_cluster_rate,family_coverage,semantic_share,fallback_share"
    const csv = `${header}\n${baselineToCsvRow(today, baseline)}\n`
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cluster-quality-baseline-${today}.csv"`,
      },
    })
  }

  return NextResponse.json({
    days,
    sampled_clusters: rows.length,
    baseline,
  })
}

/** Pick the top-count entry from a count map. Returns [null, 0] for
 *  empty input. Tie-break: lexicographic on the key (deterministic
 *  across runs — important for the snapshot CSV). */
function pickDominant(counts: Map<string, number>): [string | null, number] {
  if (counts.size === 0) return [null, 0]
  let topKey: string | null = null
  let topCount = 0
  for (const [key, count] of counts) {
    if (
      count > topCount ||
      (count === topCount && topKey != null && key < topKey)
    ) {
      topKey = key
      topCount = count
    }
  }
  return [topKey, topCount]
}
