import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

/**
 * GET /api/clusters/rollup?days=30&category=bug
 * Aggregates Layer-A `cluster_id` from mv_observation_current for the Story tab
 * and other consumers. Counts are canonical rows with non-null cluster_id.
 * Read-only; does not change cluster membership.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams
  const daysRaw = searchParams.get("days")
  const categorySlug = searchParams.get("category")

  let days: number | null = null
  if (daysRaw) {
    const p = parseInt(daysRaw, 10)
    if (Number.isFinite(p) && p > 0) days = p
  }

  let categoryIds: string[] | null = null
  if (categorySlug && categorySlug !== "all") {
    const { data: catRows } = await supabase
      .from("categories")
      .select("id")
      .eq("slug", categorySlug)
    categoryIds = (catRows || []).map((r: { id: string }) => r.id)
    if (categoryIds.length === 0) {
      return NextResponse.json({ clusters: [] })
    }
  }

  let q = supabase
    .from("mv_observation_current")
    .select("cluster_id, llm_classified_at, source_name")
    .eq("is_canonical", true)
    .not("cluster_id", "is", null)

  if (categoryIds) q = q.in("category_id", categoryIds)
  if (days) {
    const daysAgo = new Date()
    daysAgo.setDate(daysAgo.getDate() - days)
    q = q.gte("published_at", daysAgo.toISOString())
  }

  const { data: rows, error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const agg = new Map<string, { count: number; classified: number; sources: Set<string> }>()
  for (const r of rows || []) {
    const id = (r as { cluster_id: string }).cluster_id
    if (!id) continue
    const cur = agg.get(id) ?? { count: 0, classified: 0, sources: new Set<string>() }
    cur.count += 1
    if ((r as { llm_classified_at: string | null }).llm_classified_at) cur.classified += 1
    const sourceName = (r as { source_name?: string | null }).source_name
    if (sourceName) cur.sources.add(sourceName)
    agg.set(id, cur)
  }

  const sorted = Array.from(agg.entries())
    .map(([id, v]) => ({ id, count: v.count, classified: v.classified, source_count: v.sources.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)

  if (sorted.length === 0) {
    return NextResponse.json({ clusters: [] })
  }

  const { data: clusterRows, error: cErr } = await supabase
    .from("clusters")
    .select("id, label, label_confidence")
    .in(
      "id",
      sorted.map((s) => s.id),
    )

  if (cErr) {
    return NextResponse.json({ error: cErr.message }, { status: 500 })
  }

  const labelMap = new Map((clusterRows || []).map((c: any) => [c.id, c]))

  const topIds = sorted.map((s) => s.id)
  const { data: exemplarRows } = await supabase
    .from("mv_observation_current")
    .select("cluster_id, observation_id, title, impact_score")
    .eq("is_canonical", true)
    .in("cluster_id", topIds)
    .order("impact_score", { ascending: false })
    .limit(300)
  const exemplarMap = new Map<string, { title: string; observationId: string | null }>()
  for (const row of exemplarRows || []) {
    const clusterId = (row as { cluster_id: string | null }).cluster_id
    const title = (row as { title: string | null }).title
    const observationId = (row as { observation_id?: string | null }).observation_id ?? null
    if (!clusterId || !title || exemplarMap.has(clusterId)) continue
    exemplarMap.set(clusterId, { title, observationId })
  }

  const computeWhySurfaced = (count: number, sourceCount: number, reviewedCount: number) => {
    const reviewPressure = Math.max(0, count - reviewedCount)
    if (reviewPressure >= 8) return "high review pressure"
    if (count >= 10) return "high volume in current window"
    if (sourceCount >= 3) return "cross-source signal concentration"
    return "representative semantic cluster"
  }

  const bucketRailTags = (inputs: {
    actionabilityInput: number
    surgeInput: number
    reviewPressureInput: number
  }) => {
    const tags: Array<"actionability" | "surge" | "review_pressure"> = []
    if (inputs.actionabilityInput >= 0.5) tags.push("actionability")
    if (inputs.surgeInput >= 6) tags.push("surge")
    if (inputs.reviewPressureInput >= 5) tags.push("review_pressure")
    return tags
  }

  const { data: healthRows, error: hErr } = await supabase
    .from("mv_cluster_health_current")
    .select(
      "cluster_id, cluster_path, reviewed_count, fingerprint_hit_rate, dominant_error_code_share, dominant_stack_frame_share, intra_cluster_similarity_proxy, nearest_cluster_gap_proxy",
    )
    .in("cluster_id", topIds)

  if (hErr) {
    return NextResponse.json({ error: hErr.message }, { status: 500 })
  }
  const healthMap = new Map((healthRows || []).map((h: any) => [h.cluster_id, h]))

  const clusters = sorted.map((s) => {
    const meta = labelMap.get(s.id)
    const health = healthMap.get(s.id)
    const reviewedCount = Number(health?.reviewed_count ?? 0)
    const actionabilityInput = Number(
      ((Number(health?.fingerprint_hit_rate ?? 0) * 0.5) +
        (Number(health?.dominant_error_code_share ?? 0) * 0.3) +
        (Number(health?.dominant_stack_frame_share ?? 0) * 0.2)).toFixed(4),
    )
    const surgeInput = s.count
    const reviewPressureInput = Math.max(0, s.count - reviewedCount)
    const exemplar = exemplarMap.get(s.id)
    return {
      id: s.id,
      count: s.count,
      classified_count: s.classified,
      reviewed_count: reviewedCount,
      source_count: s.source_count,
      label: meta?.label ?? null,
      label_confidence: meta?.label_confidence ?? null,
      representative_title: exemplar?.title ?? null,
      representative_observation_id: exemplar?.observationId ?? null,
      why_surfaced: computeWhySurfaced(s.count, s.source_count, reviewedCount),
      rail_scoring: {
        actionability_input: actionabilityInput,
        surge_input: surgeInput,
        review_pressure_input: reviewPressureInput,
        rail_tags: bucketRailTags({ actionabilityInput, surgeInput, reviewPressureInput }),
      },
      cluster_path: (health?.cluster_path ?? "fallback") as "semantic" | "fallback",
      fingerprint_hit_rate: Number(health?.fingerprint_hit_rate ?? 0),
      dominant_error_code_share: Number(health?.dominant_error_code_share ?? 0),
      dominant_stack_frame_share: Number(health?.dominant_stack_frame_share ?? 0),
      intra_cluster_similarity_proxy: Number(health?.intra_cluster_similarity_proxy ?? 0),
      nearest_cluster_gap_proxy: Number(health?.nearest_cluster_gap_proxy ?? 0),
    }
  })

  return NextResponse.json({ clusters })
}
