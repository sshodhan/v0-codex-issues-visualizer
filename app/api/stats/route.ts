import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { computeRealtimeInsights } from "@/lib/analytics/realtime"
import {
  computeCompetitiveMentions,
  summarizeCompetitiveMentions,
} from "@/lib/analytics/competitive"
import {
  computeActionability,
  computeActionabilityBreakdown,
} from "@/lib/analytics/actionability"

type Sentiment = "positive" | "negative" | "neutral"

interface CategorySentimentAccumulator {
  name: string
  color: string
  positive: number
  neutral: number
  negative: number
  total: number
  impactSum: number
  topIssue: {
    title: string
    url: string | null
    impact_score: number
  } | null
}

// Reads mv_observation_current (one row per canonical observation with all
// derivation signals joined) and mv_trend_daily (30-day date buckets).
// Both materialized views are rebuilt at /api/cron/scrape end.
//
// When ?as_of=<ISO8601> is supplied, reads are routed through the
// observation_current_as_of(ts) RPC instead of the materialized view, so
// derivations are constrained to computed_at <= as_of and cluster
// membership is interval-bounded. Trend data in as_of mode is computed
// from the time-bounded result set in-process rather than from
// mv_trend_daily (which always reflects current state).
//
// See docs/ARCHITECTURE.md v10 §§3.1c, 5.3, 7.4, 11.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams
  const asOfRaw = searchParams.get("as_of")

  let asOf: Date | null = null
  if (asOfRaw) {
    const parsed = new Date(asOfRaw)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        {
          error: "Invalid as_of",
          message: "as_of must be a valid ISO8601 timestamp (e.g. 2026-04-21T12:00:00.000Z)",
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

  // Parse global filter params
  const daysRaw = searchParams.get("days")
  const categorySlug = searchParams.get("category")
  let filterDays: number | null = null
  if (daysRaw) {
    const parsed = parseInt(daysRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      filterDays = parsed
    }
  }

  // When asOf is set, read from the time-bounded RPC; otherwise from the
  // always-current materialized view. Result shape is identical so the
  // downstream aggregation loop is shared.
  let rows: any[]
  if (asOf) {
    const { data, error } = await supabase.rpc("observation_current_as_of", {
      ts: asOf.toISOString(),
    })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    rows = (data || []).filter((r: any) => r.is_canonical === true)
  } else {
    const { data: allRows } = await supabase
      .from("mv_observation_current")
      .select("*")
      .eq("is_canonical", true)
    rows = allRows || []
  }

  // Lookup tables for name/color join (cheap — two small tables).
  type SourceRow = { id: string; name: string; slug: string }
  type CategoryRow = { id: string; name: string; slug: string; color: string }
  const [{ data: sources }, { data: categories }] = await Promise.all([
    supabase.from("sources").select("id, name, slug"),
    supabase.from("categories").select("id, name, slug, color"),
  ])
  const sourceById = new Map<string, SourceRow>(
    ((sources || []) as SourceRow[]).map((s) => [s.id, s]),
  )
  const categoryById = new Map<string, CategoryRow>(
    ((categories || []) as CategoryRow[]).map((c) => [c.id, c]),
  )

  // Lookup category ID by slug for filtering
  let filterCategoryId: string | null = null
  if (categorySlug && categorySlug !== "all") {
    const matchingCat = (categories || []).find((c: CategoryRow) => c.slug === categorySlug)
    filterCategoryId = matchingCat?.id ?? null
  }

  // Apply global filters (days and category)
  const unfilteredTotal = rows.length
  const filterAnchor = asOf ? asOf.getTime() : Date.now()
  if (filterDays || filterCategoryId) {
    const cutoffTime = filterDays ? filterAnchor - filterDays * 24 * 60 * 60 * 1000 : null
    rows = rows.filter((r: any) => {
      // Time filter
      if (cutoffTime && r.published_at) {
        const pubTime = new Date(r.published_at).getTime()
        if (pubTime < cutoffTime) return false
      }
      // Category filter
      if (filterCategoryId && r.category_id !== filterCategoryId) return false
      return true
    })
  }

  const totalIssues = rows.length

  const sentimentCounts = { positive: 0, negative: 0, neutral: 0 }
  const sourceCounts: Record<string, number> = {}
  const categoryCounts: Record<string, { count: number; color: string }> = {}
  const categorySentimentMap: Record<string, CategorySentimentAccumulator> = {}
  /** Latest LLM `category` from mv (joined classifications), same window as totalIssues. */
  const llmCategoryCounts: Record<string, number> = {}
  let llmClassifiedInWindow = 0
  let llmPendingInWindow = 0

  for (const r of rows) {
    if (r.sentiment && r.sentiment in sentimentCounts) {
      sentimentCounts[r.sentiment as Sentiment]++
    }

    const src = r.source_id ? sourceById.get(r.source_id) : null
    if (src) {
      sourceCounts[src.name] = (sourceCounts[src.name] || 0) + 1
    }

    const cat = r.category_id ? categoryById.get(r.category_id) : null
    if (cat) {
      if (!categoryCounts[cat.name]) {
        categoryCounts[cat.name] = { count: 0, color: cat.color }
      }
      categoryCounts[cat.name].count++

      if (!categorySentimentMap[cat.name]) {
        categorySentimentMap[cat.name] = {
          name: cat.name,
          color: cat.color,
          positive: 0,
          neutral: 0,
          negative: 0,
          total: 0,
          impactSum: 0,
          topIssue: null,
        }
      }
      const bucket = categorySentimentMap[cat.name]
      const sentiment = (r.sentiment as Sentiment | null) ?? null
      if (sentiment) bucket[sentiment] += 1
      bucket.total += 1
      const issueImpact = Number(r.impact_score) || 0
      bucket.impactSum += issueImpact

      if (!bucket.topIssue || issueImpact > bucket.topIssue.impact_score) {
        bucket.topIssue = {
          title: (r.title as string) || "Untitled issue",
          url: (r.url as string | null) ?? null,
          impact_score: issueImpact,
        }
      }
    }

    if (r.llm_classified_at) {
      llmClassifiedInWindow += 1
      const k = (r.llm_category as string | null) || "uncategorized"
      llmCategoryCounts[k] = (llmCategoryCounts[k] || 0) + 1
    } else {
      llmPendingInWindow += 1
    }
  }

  const categorySentimentBreakdown = Object.values(categorySentimentMap).map((entry) => ({
    name: entry.name,
    color: entry.color,
    positive: entry.positive,
    neutral: entry.neutral,
    negative: entry.negative,
    total: entry.total,
    avgImpact: entry.total > 0 ? entry.impactSum / entry.total : 0,
    topIssue: entry.topIssue,
  }))

  // Trend sparkline. In live mode read the pre-bucketed materialized view.
  // In as_of mode derive buckets from the time-bounded `rows` set so the
  // trend chart matches what was visible at that point in time.
  const trendByDay: Record<
    string,
    { date: string; positive: number; negative: number; neutral: number; total: number }
  > = {}

  if (asOf) {
    const windowStart = new Date(asOf.getTime() - 30 * 24 * 60 * 60 * 1000)
    for (const r of rows) {
      if (!r.published_at) continue
      const published = new Date(r.published_at as string)
      if (Number.isNaN(published.getTime()) || published < windowStart || published > asOf) continue
      const date = (r.published_at as string).split("T")[0]
      if (!trendByDay[date]) {
        trendByDay[date] = { date, positive: 0, negative: 0, neutral: 0, total: 0 }
      }
      trendByDay[date].total += 1
      const sentiment = r.sentiment as Sentiment | null
      if (sentiment && trendByDay[date][sentiment] !== undefined) {
        trendByDay[date][sentiment] += 1
      }
    }
  } else {
    const { data: trendRows } = await supabase
      .from("mv_trend_daily")
      .select("day, sentiment, cnt")
      .order("day", { ascending: true })

    for (const t of trendRows || []) {
      const date = (t.day as string).split("T")[0]
      if (!trendByDay[date]) {
        trendByDay[date] = { date, positive: 0, negative: 0, neutral: 0, total: 0 }
      }
      trendByDay[date].total += Number(t.cnt) || 0
      if (t.sentiment && trendByDay[date][t.sentiment as Sentiment] !== undefined) {
        trendByDay[date][t.sentiment as Sentiment] += Number(t.cnt) || 0
      }
    }
  }

  // Priority Matrix — same canonical rows, project down to the fields the
  // chart expects. `id` is aliased from observation_id for the UI. The
  // fingerprint block is forwarded so the dashboard can render the
  // layered regex → LLM signal panel per cluster (see
  // components/dashboard/signal-layers.tsx).
  //
  // Per-row `actionability` (outcome D) replaces the legacy `priorityScore`
  // as the matrix's ranking authority. `priorityScore` is retained on the
  // payload for back-compat with any consumer that keyed on it. The per-
  // cluster `source_diversity` input is fetched from the
  // `v_cluster_source_diversity` view (added in migration 014) — one
  // small grouped read regardless of MV size, instead of reconstructing
  // cross-source counts per-row.
  const sourceDiversityByCluster = await fetchClusterSourceDiversity(supabase, rows)
  const priorityMatrix = rows.map((r: any) => {
    const impactScore = Number(r.impact_score ?? 0)
    const frequencyCount = Number(r.frequency_count ?? 1)
    const reproMarkers = Number(r.repro_markers ?? 0)
    const sourceDiversity = r.cluster_id
      ? sourceDiversityByCluster.get(r.cluster_id) ?? 1
      : 1
    const actionability = computeActionability({
      impact_score: impactScore,
      frequency_count: frequencyCount,
      error_code: r.error_code ?? null,
      repro_markers: reproMarkers,
      source_diversity: sourceDiversity,
    })
    const actionabilityBreakdown = computeActionabilityBreakdown({
      impact_score: impactScore,
      frequency_count: frequencyCount,
      error_code: r.error_code ?? null,
      repro_markers: reproMarkers,
      source_diversity: sourceDiversity,
    })
    // Legacy blended score — kept so any existing consumer that keyed on
    // `priorityScore` keeps rendering identically. New UI surfaces should
    // prefer `actionability` (see docs/SCORING.md §10.1).
    const priorityScore = Math.round(
      ((impactScore / 10) * 0.65 + Math.min(frequencyCount / 10, 1) * 0.35) * 100,
    )
    return {
      id: r.observation_id,
      title: r.title,
      content: r.content ?? null,
      url: r.url ?? null,
      impact_score: impactScore,
      frequency_count: frequencyCount,
      source_diversity: sourceDiversity,
      actionability,
      actionability_breakdown: actionabilityBreakdown,
      priorityScore,
      sentiment: r.sentiment ?? "neutral",
      cluster_key_compound: r.cluster_key_compound ?? null,
      category: r.category_id ? categoryById.get(r.category_id) : null,
      fingerprint: {
        error_code: r.error_code ?? null,
        top_stack_frame: r.top_stack_frame ?? null,
        top_stack_frame_hash: r.top_stack_frame_hash ?? null,
        cli_version: r.cli_version ?? null,
        os: r.fp_os ?? null,
        shell: r.fp_shell ?? null,
        editor: r.fp_editor ?? null,
        model_id: r.model_id ?? null,
        repro_markers: reproMarkers,
        keyword_presence: r.fp_keyword_presence ?? 0,
        llm_subcategory: r.llm_subcategory ?? null,
        llm_primary_tag: r.llm_primary_tag ?? null,
        algorithm_version: r.fingerprint_algorithm_version ?? null,
      },
    }
  })

  // 6-day window for realtime insights and competitive mentions. In as_of
  // mode the window is anchored at the as_of point, not now().
  const anchor = asOf ? asOf.getTime() : Date.now()
  const sixDaysAgoIso = new Date(anchor - 6 * 24 * 60 * 60 * 1000).toISOString()
  const anchorIso = new Date(anchor).toISOString()
  const recentRows = rows.filter(
    (r: any) => r.published_at && r.published_at >= sixDaysAgoIso && r.published_at <= anchorIso,
  )
  const normalizedRecent = recentRows.map((r: any) => ({
    id: r.observation_id,
    title: r.title,
    content: r.content ?? null,
    url: r.url ?? null,
    published_at: r.published_at ?? null,
    sentiment: (r.sentiment as Sentiment | null) ?? null,
    impact_score: (r.impact_score as number | null) ?? null,
    category: (r.category_id ? categoryById.get(r.category_id) : null) ?? null,
    source: (r.source_id ? sourceById.get(r.source_id) : null) ?? null,
    llm_category: (r.llm_category as string | null) ?? null,
  }))

  const realtimeInsights = computeRealtimeInsights(normalizedRecent)
  const competitiveMentions = computeCompetitiveMentions(normalizedRecent)
  const competitiveMentionsMeta = summarizeCompetitiveMentions(competitiveMentions)

  // Last scrape metadata. In as_of mode, bound by started_at <= as_of so a
  // replayed dashboard shows the scrape banner that was current then.
  //
  // Excludes source_id IS NULL rows (written by /api/cron/classify-backfill)
  // — those are LLM-backfill runs, not scrapes. Surfacing them in the
  // "Last synced" header chip would make the chip claim a sync happened
  // when no upstream provider was contacted. Backfill activity has its
  // own surface (BUGS.md N-10 follow-up: admin one-shot panel).
  const lastScrapeQuery = supabase
    .from("scrape_logs")
    .select("*")
    .not("source_id", "is", null)
    .order("started_at", { ascending: false })
    .limit(1)
  if (asOf) {
    lastScrapeQuery.lte("started_at", asOf.toISOString())
  }
  const { data: lastScrapeRows } = await lastScrapeQuery
  const lastScrape = (lastScrapeRows && lastScrapeRows[0]) || null

  const llmCategoryBreakdown = Object.entries(llmCategoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  return NextResponse.json({
    totalIssues,
    sentimentBreakdown: sentimentCounts,
    sourceBreakdown: Object.entries(sourceCounts).map(([name, count]) => ({
      name,
      count,
    })),
    categoryBreakdown: Object.entries(categoryCounts).map(([name, data]) => ({
      name,
      count: data.count,
      color: data.color,
    })),
    llmCategoryBreakdown,
    llmClassifiedInWindow,
    llmPendingInWindow,
    categorySentimentBreakdown,
    trendData: Object.values(trendByDay),
    priorityMatrix,
    realtimeInsights,
    competitiveMentions,
    competitiveMentionsMeta,
    lastScrape,
    asOf: asOf ? asOf.toISOString() : null,
  }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } })
}

// Per-cluster source diversity feeds the 7% source-diversity term in the
// actionability score. We read the v_cluster_source_diversity view added
// in migration 014 rather than re-aggregating mv_observation_current here
// so the math stays in one place. If the view isn't available yet (e.g. a
// deploy that ran before 014), the map falls back empty and the
// actionability contribution degrades gracefully to 0 — never a hard error.
async function fetchClusterSourceDiversity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: any[],
): Promise<Map<string, number>> {
  const clusterIds = new Set<string>()
  for (const r of rows) if (r.cluster_id) clusterIds.add(r.cluster_id as string)
  if (clusterIds.size === 0) return new Map()

  const { data, error } = await supabase
    .from("v_cluster_source_diversity")
    .select("cluster_id, source_diversity")
    .in("cluster_id", [...clusterIds])

  if (error) {
    // The view is additive — a miss doesn't corrupt the matrix, it just
    // removes the bonus term. Log and carry on.
    console.warn("[stats] v_cluster_source_diversity read failed:", error.message)
    return new Map()
  }

  return new Map<string, number>(
    ((data ?? []) as Array<{ cluster_id: string; source_diversity: number | null }>).map((row) => [
      row.cluster_id,
      Math.max(1, Number(row.source_diversity) || 1),
    ]),
  )
}
