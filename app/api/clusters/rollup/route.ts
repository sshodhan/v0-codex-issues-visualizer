import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { buildPipelineStateSummary } from "@/lib/classification/pipeline-state"

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
      return NextResponse.json({
        clusters: [],
        pipeline_state: buildPipelineStateSummary({
          observationsInWindow: 0,
          classifiedCount: 0,
          clusteredCount: 0,
        }),
      })
    }
  }

  const buildObsCountQuery = () => {
    let q = supabase
      .from("mv_observation_current")
      .select("*", { count: "exact", head: true })
      .eq("is_canonical", true)
    if (categoryIds) q = q.in("category_id", categoryIds)
    if (days) {
      const daysAgo = new Date()
      daysAgo.setDate(daysAgo.getDate() - days)
      q = q.gte("published_at", daysAgo.toISOString())
    }
    return q
  }
  const buildClassifiedCountQuery = () => {
    let q = supabase
      .from("mv_observation_current")
      .select("*", { count: "exact", head: true })
      .eq("is_canonical", true)
      .not("llm_classified_at", "is", null)
    if (categoryIds) q = q.in("category_id", categoryIds)
    if (days) {
      const daysAgo = new Date()
      daysAgo.setDate(daysAgo.getDate() - days)
      q = q.gte("published_at", daysAgo.toISOString())
    }
    return q
  }
  const buildClusteredCountQuery = () => {
    let q = supabase
      .from("mv_observation_current")
      .select("*", { count: "exact", head: true })
      .eq("is_canonical", true)
      .not("cluster_id", "is", null)
    if (categoryIds) q = q.in("category_id", categoryIds)
    if (days) {
      const daysAgo = new Date()
      daysAgo.setDate(daysAgo.getDate() - days)
      q = q.gte("published_at", daysAgo.toISOString())
    }
    return q
  }

  const [obsCountRes, classifiedCountRes, clusteredCountRes] = await Promise.all([
    buildObsCountQuery(),
    buildClassifiedCountQuery(),
    buildClusteredCountQuery(),
  ])
  const pipeline_state = buildPipelineStateSummary({
    observationsInWindow: obsCountRes.count ?? 0,
    classifiedCount: classifiedCountRes.count ?? 0,
    clusteredCount: clusteredCountRes.count ?? 0,
    sourceHealthy: !obsCountRes.error && !classifiedCountRes.error && !clusteredCountRes.error,
  })

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
    return NextResponse.json({ error: error.message, pipeline_state }, { status: 500 })
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
    return NextResponse.json({ clusters: [], pipeline_state })
  }

  const { data: clusterRows, error: cErr } = await supabase
    .from("clusters")
    .select("id, label, label_confidence")
    .in(
      "id",
      sorted.map((s) => s.id),
    )

  if (cErr) {
    return NextResponse.json({ error: cErr.message, pipeline_state }, { status: 500 })
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

  const [healthResult, fpResult] = await Promise.all([
    supabase
      .from("mv_cluster_health_current")
      .select(
        "cluster_id, cluster_path, reviewed_count, fingerprint_hit_rate, dominant_error_code_share, dominant_stack_frame_share, intra_cluster_similarity_proxy, nearest_cluster_gap_proxy",
      )
      .in("cluster_id", topIds),
    // Fingerprint enrichment for the top clusters: aggregates regex
    // variants, breadth (sources + OS), and avg_impact so V3 cards can
    // render the Trust & Completeness / Regex Variants / Sources & Env
    // panels without a second round-trip.
    //
    // Sampling note: we cap at 2000 rows total across the top 50 clusters
    // (≈40 rows per cluster on average). Ordering by cluster_id then
    // impact_score DESC makes the sample deterministic and biases toward
    // high-signal observations; a single very-large cluster can still
    // consume more than its share, but we'd rather undersample tail
    // clusters than run 50 serial queries on the hot path.
    supabase
      .from("mv_observation_current")
      .select("cluster_id, error_code, top_stack_frame, fp_os, fp_shell, cli_version, model_id, source_name, impact_score")
      .eq("is_canonical", true)
      .in("cluster_id", topIds)
      .order("cluster_id", { ascending: true })
      .order("impact_score", { ascending: false })
      .limit(2000),
  ])

  if (healthResult.error) {
    return NextResponse.json({ error: healthResult.error.message, pipeline_state }, { status: 500 })
  }
  if (fpResult.error) {
    return NextResponse.json({ error: fpResult.error.message, pipeline_state }, { status: 500 })
  }
  const healthMap = new Map((healthResult.data || []).map((h: any) => [h.cluster_id, h]))

  type FpRow = {
    cluster_id: string | null
    error_code: string | null
    top_stack_frame: string | null
    fp_os: string | null
    fp_shell: string | null
    cli_version: string | null
    model_id: string | null
    source_name: string | null
    impact_score: number | null
  }

  type RegexVariant = { kind: "err" | "stack" | "env" | "sdk"; value: string }
  type ClusterFpAgg = {
    errorCodes: Map<string, number>
    stackFrames: Map<string, number>
    osTokens: Map<string, number>
    shellTokens: Map<string, number>
    sdkVersions: Map<string, number>
    sourceCountMap: Map<string, number>
    impactScores: number[]
  }

  const fpAggMap = new Map<string, ClusterFpAgg>()
  for (const row of (fpResult.data || []) as FpRow[]) {
    if (!row.cluster_id) continue
    const agg: ClusterFpAgg = fpAggMap.get(row.cluster_id) ?? {
      errorCodes: new Map<string, number>(),
      stackFrames: new Map<string, number>(),
      osTokens: new Map<string, number>(),
      shellTokens: new Map<string, number>(),
      sdkVersions: new Map<string, number>(),
      sourceCountMap: new Map<string, number>(),
      impactScores: [] as number[],
    }
    if (row.error_code) agg.errorCodes.set(row.error_code, (agg.errorCodes.get(row.error_code) ?? 0) + 1)
    if (row.top_stack_frame) agg.stackFrames.set(row.top_stack_frame, (agg.stackFrames.get(row.top_stack_frame) ?? 0) + 1)
    if (row.fp_os) agg.osTokens.set(row.fp_os, (agg.osTokens.get(row.fp_os) ?? 0) + 1)
    if (row.fp_shell) agg.shellTokens.set(row.fp_shell, (agg.shellTokens.get(row.fp_shell) ?? 0) + 1)
    if (row.cli_version) agg.sdkVersions.set(row.cli_version, (agg.sdkVersions.get(row.cli_version) ?? 0) + 1)
    if (row.source_name) agg.sourceCountMap.set(row.source_name, (agg.sourceCountMap.get(row.source_name) ?? 0) + 1)
    if (row.impact_score != null) agg.impactScores.push(Number(row.impact_score))
    fpAggMap.set(row.cluster_id, agg)
  }

  const topNByCount = <T>(m: Map<T, number>, n: number): T[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k)

  const buildRegexVariants = (agg: ClusterFpAgg | undefined): RegexVariant[] => {
    if (!agg) return []
    const variants: RegexVariant[] = []
    for (const v of topNByCount(agg.errorCodes, 2)) variants.push({ kind: "err", value: String(v) })
    for (const v of topNByCount(agg.stackFrames, 2)) variants.push({ kind: "stack", value: String(v) })
    // "env" chips surface OS first, then shell — they're both env signals
    // but distinct enough that we don't collapse them into a single map.
    const envCombined = new Map<string, number>()
    for (const [k, v] of agg.osTokens.entries()) envCombined.set(k, v)
    for (const [k, v] of agg.shellTokens.entries()) envCombined.set(k, (envCombined.get(k) ?? 0) + v)
    for (const v of topNByCount(envCombined, 2)) variants.push({ kind: "env", value: String(v) })
    for (const v of topNByCount(agg.sdkVersions, 1)) variants.push({ kind: "sdk", value: `CLI v${v}` })
    return variants.slice(0, 8)
  }

  const buildBreadth = (agg: ClusterFpAgg | undefined) => {
    const sources: Record<string, number> = {}
    if (agg) {
      for (const [k, v] of agg.sourceCountMap.entries()) sources[k] = v
    }
    const os = agg ? topNByCount(agg.osTokens, 4).map(String) : []
    return { sources, os }
  }

  const buildAvgImpact = (agg: ClusterFpAgg | undefined): number | null => {
    if (!agg || agg.impactScores.length === 0) return null
    const avg = agg.impactScores.reduce((a, b) => a + b, 0) / agg.impactScores.length
    return Math.round(avg * 10) / 10
  }

  const clusters = sorted.map((s) => {
    const meta = labelMap.get(s.id)
    const health = healthMap.get(s.id)
    const fpAgg = fpAggMap.get(s.id)
    const reviewedCount = Number(health?.reviewed_count ?? 0)
    const actionabilityInput = Number(
      ((Number(health?.fingerprint_hit_rate ?? 0) * 0.5) +
        (Number(health?.dominant_error_code_share ?? 0) * 0.3) +
        (Number(health?.dominant_stack_frame_share ?? 0) * 0.2)).toFixed(4),
    )
    const surgeInput = s.count
    const reviewPressureInput = Math.max(0, s.count - reviewedCount)
    const exemplar = exemplarMap.get(s.id)
    const classifiedShare = s.count > 0 ? Math.round((s.classified / s.count) * 100) / 100 : 0
    const humanReviewedShare = s.count > 0 ? Math.round((reviewedCount / s.count) * 100) / 100 : 0
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
      classified_share: classifiedShare,
      human_reviewed_share: humanReviewedShare,
      avg_impact: buildAvgImpact(fpAgg),
      regex_variants: buildRegexVariants(fpAgg),
      breadth: buildBreadth(fpAgg),
    }
  })

  return NextResponse.json({ clusters, pipeline_state })
}
