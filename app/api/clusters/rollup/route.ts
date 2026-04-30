import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { buildPipelineStateSummary } from "@/lib/classification/pipeline-state"
import { logServerError } from "@/lib/error-tracking/server-logger"
import { CLUSTER_SURGE_WINDOW_HOURS } from "@/lib/classification/rollup-constants"
import {
  dominantSeverity as computeDominantSeverity,
  negativeSentimentPct as computeNegativeSentimentPct,
  surgeDeltaPct as computeSurgeDeltaPct,
} from "@/lib/classification/cluster-gating"

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
      return NextResponse.json(
        {
          clusters: [],
          pipeline_state: buildPipelineStateSummary({
            observationsInWindow: 0,
            classifiedCount: 0,
            clusteredCount: 0,
          }),
        },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
      )
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
    logServerError("clusters-rollup", "main_rows_query_failed", error, { days, categorySlug })
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

  const allClusterIds = Array.from(agg.keys())
  const sorted = Array.from(agg.entries())
    .map(([id, v]) => ({ id, count: v.count, classified: v.classified, source_count: v.sources.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)

  if (sorted.length === 0) {
    return NextResponse.json(
      { clusters: [], cluster_labels: [], cluster_families: [], pipeline_state },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    )
  }

  // Fetch labels for every cluster in the window, not just the top-50 cards.
  // The Story view's family legend joins on cluster_id from /api/issues, which
  // can reference clusters outside the top-50; without these labels those dots
  // collapse into the "Unlabelled Family" bucket on the Signal cloud.
  const { data: clusterRows, error: cErr } = await supabase
    .from("clusters")
    .select("id, label, label_confidence")
    .in("id", allClusterIds)

  if (cErr) {
    logServerError("clusters-rollup", "clusters_labels_query_failed", cErr, {
      totalClusterCount: allClusterIds.length,
      topClusterCount: sorted.length,
    })
    return NextResponse.json({ error: cErr.message, pipeline_state }, { status: 500 })
  }

  const labelMap = new Map((clusterRows || []).map((c: any) => [c.id, c]))
  const clusterLabels = (clusterRows || []).map((c: any) => ({ id: c.id, label: c.label ?? null }))

  // Stage-4 family titles for every cluster in the window — same long-tail
  // rationale as the labels query above. Failures are non-fatal: the
  // `family_classification_current` view is newer than `clusters` and may
  // not be provisioned in every environment. The Signal cloud falls back
  // to "Pending family classification" on the client when missing, so a
  // broken read on this view shouldn't 500 the whole rollup.
  const { data: familyRows, error: familyErr } = await supabase
    .from("family_classification_current")
    .select("cluster_id, family_title, family_kind, needs_human_review")
    .in("cluster_id", allClusterIds)

  if (familyErr) {
    logServerError("clusters-rollup", "cluster_families_query_failed", familyErr, { allClusterCount: allClusterIds.length })
  }
  const safeFamilyRows = familyErr ? [] : (familyRows || [])

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

  // Two time-bucketed windows for surge_delta_pct. The windows are
  // CLUSTER_SURGE_WINDOW_HOURS wide; we compare the most recent window
  // to the prior window. Matches the scrape cron cadence — see
  // lib/classification/rollup-constants.ts and vercel.json crons.
  const nowMs = Date.now()
  const recentWindowStart = new Date(nowMs - CLUSTER_SURGE_WINDOW_HOURS * 60 * 60 * 1000)
  const priorWindowStart = new Date(nowMs - 2 * CLUSTER_SURGE_WINDOW_HOURS * 60 * 60 * 1000)

  const [healthResult, fpResult, recentWindowResult, priorWindowResult] = await Promise.all([
    supabase
      .from("mv_cluster_health_current")
      .select(
        "cluster_id, cluster_path, reviewed_count, fingerprint_hit_rate, dominant_error_code_share, dominant_stack_frame_share, intra_cluster_similarity_proxy, nearest_cluster_gap_proxy",
      )
      .in("cluster_id", topIds),
    // Fingerprint enrichment for the top clusters: aggregates regex
    // variants, breadth (sources + OS), severity/sentiment distributions,
    // and avg_impact so V3 cards can render the Trust & Completeness /
    // Regex Variants / Sources & Env panels + state chips + why-surfaced
    // narrative without a second round-trip.
    //
    // Sampling note: we cap at 2000 rows total across the top 50 clusters
    // (≈40 rows per cluster on average). Ordering by cluster_id then
    // impact_score DESC makes the sample deterministic and biases toward
    // high-signal observations; a single very-large cluster can still
    // consume more than its share, but we'd rather undersample tail
    // clusters than run 50 serial queries on the hot path.
    //
    // `llm_severity`, `sentiment`, `sentiment_score` added in Tier 2A
    // (v16 of ARCHITECTURE.md) to back the HIGH SEVERITY / CRITICAL
    // state chip and the "N% negative sentiment" clause in why-surfaced.
    supabase
      .from("mv_observation_current")
      .select("cluster_id, error_code, top_stack_frame, fp_os, fp_shell, cli_version, model_id, source_name, impact_score, llm_severity, sentiment, sentiment_score")
      .eq("is_canonical", true)
      .in("cluster_id", topIds)
      .order("cluster_id", { ascending: true })
      .order("impact_score", { ascending: false })
      .limit(2000),
    // Time-bucketed count for the "recent" window (last N hours).
    // Lightweight — just cluster_id + published_at for gate bucketing.
    supabase
      .from("mv_observation_current")
      .select("cluster_id")
      .eq("is_canonical", true)
      .in("cluster_id", topIds)
      .gte("published_at", recentWindowStart.toISOString()),
    // Prior-window count (N..2N hours ago). Empty denominator is handled
    // via MIN_PRIOR_WINDOW_FOR_SURGE gating downstream — we simply return
    // surge_delta_pct = null for those clusters rather than dividing by 0.
    supabase
      .from("mv_observation_current")
      .select("cluster_id")
      .eq("is_canonical", true)
      .in("cluster_id", topIds)
      .gte("published_at", priorWindowStart.toISOString())
      .lt("published_at", recentWindowStart.toISOString()),
  ])

  if (healthResult.error) {
    logServerError("clusters-rollup", "health_query_failed", healthResult.error, { topClusterCount: topIds.length })
    return NextResponse.json({ error: healthResult.error.message, pipeline_state }, { status: 500 })
  }
  if (fpResult.error) {
    logServerError("clusters-rollup", "fingerprint_query_failed", fpResult.error, { topClusterCount: topIds.length })
    return NextResponse.json({ error: fpResult.error.message, pipeline_state }, { status: 500 })
  }
  // Surge-window query failures are non-fatal: the cards still render
  // without the "+N% 6h trend" affordance. Log and continue so one broken
  // MV read doesn't 500 the whole V3 surface.
  if (recentWindowResult.error) {
    logServerError("clusters-rollup", "recent_window_query_failed", recentWindowResult.error, { topClusterCount: topIds.length })
  }
  if (priorWindowResult.error) {
    logServerError("clusters-rollup", "prior_window_query_failed", priorWindowResult.error, { topClusterCount: topIds.length })
  }
  const healthMap = new Map((healthResult.data || []).map((h: any) => [h.cluster_id, h]))

  const recentWindowCounts = new Map<string, number>()
  for (const row of (recentWindowResult.data || []) as Array<{ cluster_id: string | null }>) {
    if (!row.cluster_id) continue
    recentWindowCounts.set(row.cluster_id, (recentWindowCounts.get(row.cluster_id) ?? 0) + 1)
  }
  const priorWindowCounts = new Map<string, number>()
  for (const row of (priorWindowResult.data || []) as Array<{ cluster_id: string | null }>) {
    if (!row.cluster_id) continue
    priorWindowCounts.set(row.cluster_id, (priorWindowCounts.get(row.cluster_id) ?? 0) + 1)
  }

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
    llm_severity: string | null
    sentiment: string | null
    sentiment_score: number | null
  }

  type RegexVariant = { kind: "err" | "stack" | "env" | "sdk"; value: string }
  type SeverityDist = { low: number; medium: number; high: number; critical: number }
  type SentimentDist = { positive: number; neutral: number; negative: number }
  type ClusterFpAgg = {
    errorCodes: Map<string, number>
    stackFrames: Map<string, number>
    osTokens: Map<string, number>
    shellTokens: Map<string, number>
    sdkVersions: Map<string, number>
    sourceCountMap: Map<string, number>
    impactScores: number[]
    severity: SeverityDist
    /** Count of observations that actually had an LLM severity set.
     *  Divisor for the severity distribution. */
    severityClassifiedCount: number
    sentiment: SentimentDist
    /** Count of observations that had any sentiment label — divisor for
     *  the negative_sentiment_pct computation. */
    sentimentLabelledCount: number
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
      severity: { low: 0, medium: 0, high: 0, critical: 0 },
      severityClassifiedCount: 0,
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      sentimentLabelledCount: 0,
    }
    if (row.error_code) agg.errorCodes.set(row.error_code, (agg.errorCodes.get(row.error_code) ?? 0) + 1)
    if (row.top_stack_frame) agg.stackFrames.set(row.top_stack_frame, (agg.stackFrames.get(row.top_stack_frame) ?? 0) + 1)
    if (row.fp_os) agg.osTokens.set(row.fp_os, (agg.osTokens.get(row.fp_os) ?? 0) + 1)
    if (row.fp_shell) agg.shellTokens.set(row.fp_shell, (agg.shellTokens.get(row.fp_shell) ?? 0) + 1)
    if (row.cli_version) agg.sdkVersions.set(row.cli_version, (agg.sdkVersions.get(row.cli_version) ?? 0) + 1)
    if (row.source_name) agg.sourceCountMap.set(row.source_name, (agg.sourceCountMap.get(row.source_name) ?? 0) + 1)
    if (row.impact_score != null) agg.impactScores.push(Number(row.impact_score))
    // LLM severity comes from `classifications.severity` joined on the
    // MV (nullable until the LLM pass has run). Count only classified
    // rows so the denominator reflects the subset the dominant_severity
    // call actually looks at — the 50%-classified gate is enforced
    // downstream where we assemble the final cluster object.
    if (row.llm_severity === "low") { agg.severity.low += 1; agg.severityClassifiedCount += 1 }
    else if (row.llm_severity === "medium") { agg.severity.medium += 1; agg.severityClassifiedCount += 1 }
    else if (row.llm_severity === "high") { agg.severity.high += 1; agg.severityClassifiedCount += 1 }
    else if (row.llm_severity === "critical") { agg.severity.critical += 1; agg.severityClassifiedCount += 1 }
    if (row.sentiment === "positive") { agg.sentiment.positive += 1; agg.sentimentLabelledCount += 1 }
    else if (row.sentiment === "neutral") { agg.sentiment.neutral += 1; agg.sentimentLabelledCount += 1 }
    else if (row.sentiment === "negative") { agg.sentiment.negative += 1; agg.sentimentLabelledCount += 1 }
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

  // Gating helpers live in lib/classification/cluster-gating.ts so the
  // honesty invariants (severity gated by classified share, sentiment
  // pct gated by min cluster size, surge gated by prior-window size)
  // can be unit-tested without standing up a Supabase client.
  const buildDominantSeverity = (agg: ClusterFpAgg | undefined, classifiedShare: number) =>
    agg ? computeDominantSeverity(agg.severity, agg.severityClassifiedCount, classifiedShare) : null
  const buildNegativeSentimentPct = (agg: ClusterFpAgg | undefined) =>
    agg ? computeNegativeSentimentPct(agg.sentiment, agg.sentimentLabelledCount) : null

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
    const dominantSeverity = buildDominantSeverity(fpAgg, classifiedShare)
    const negativeSentimentPct = buildNegativeSentimentPct(fpAgg)
    const recentWindowCount = recentWindowCounts.get(s.id) ?? 0
    const priorWindowCount = priorWindowCounts.get(s.id) ?? 0
    const surgeDeltaPct = computeSurgeDeltaPct(recentWindowCount, priorWindowCount)
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
      severity_distribution: fpAgg?.severity ?? { low: 0, medium: 0, high: 0, critical: 0 },
      dominant_severity: dominantSeverity,
      sentiment_distribution: fpAgg?.sentiment ?? { positive: 0, neutral: 0, negative: 0 },
      negative_sentiment_pct: negativeSentimentPct,
      surge_delta_pct: surgeDeltaPct,
      surge_window_hours: CLUSTER_SURGE_WINDOW_HOURS,
      recent_window_count: recentWindowCount,
      prior_window_count: priorWindowCount,
    }
  })

  return NextResponse.json(
    {
      clusters,
      cluster_labels: clusterLabels,
      cluster_families: safeFamilyRows.map((row: any) => ({
        id: row.cluster_id,
        family_title: row.family_title ?? null,
        family_kind: row.family_kind ?? null,
        needs_human_review: row.needs_human_review ?? null,
      })),
      pipeline_state,
    },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
  )
}
