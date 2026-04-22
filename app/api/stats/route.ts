import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { computeRealtimeInsights } from "@/lib/analytics/realtime"
import {
  computeCompetitiveMentions,
  summarizeCompetitiveMentions,
} from "@/lib/analytics/competitive"

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
  // chart expects. `id` is aliased from observation_id for the UI.
  const priorityMatrix = rows.map((r: any) => ({
    id: r.observation_id,
    title: r.title,
    impact_score: r.impact_score ?? 0,
    frequency_count: r.frequency_count ?? 1,
    sentiment: r.sentiment ?? "neutral",
    category: r.category_id ? categoryById.get(r.category_id) : null,
  }))

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
  }))

  const realtimeInsights = computeRealtimeInsights(normalizedRecent)
  const competitiveMentions = computeCompetitiveMentions(normalizedRecent)
  const competitiveMentionsMeta = summarizeCompetitiveMentions(competitiveMentions)

  // Last scrape metadata. In as_of mode, bound by started_at <= as_of so a
  // replayed dashboard shows the scrape banner that was current then.
  const lastScrapeQuery = supabase
    .from("scrape_logs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
  if (asOf) {
    lastScrapeQuery.lte("started_at", asOf.toISOString())
  }
  const { data: lastScrapeRows } = await lastScrapeQuery
  const lastScrape = (lastScrapeRows && lastScrapeRows[0]) || null

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
    categorySentimentBreakdown,
    trendData: Object.values(trendByDay),
    priorityMatrix,
    realtimeInsights,
    competitiveMentions,
    competitiveMentionsMeta,
    lastScrape,
    asOf: asOf ? asOf.toISOString() : null,
  })
}
