import { NextResponse } from "next/server"
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
// See docs/ARCHITECTURE.md v10 §§3.1c, 5.3, 7.4.
export async function GET() {
  const supabase = await createClient()

  // Canonical rows only — mv_observation_current already filters via
  // is_canonical, but the predicate is explicit for clarity.
  const { data: allRows } = await supabase
    .from("mv_observation_current")
    .select("*")
    .eq("is_canonical", true)

  const rows = allRows || []
  const totalIssues = rows.length

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

  // Trend sparkline — read the pre-bucketed view.
  const { data: trendRows } = await supabase
    .from("mv_trend_daily")
    .select("day, sentiment, cnt")
    .order("day", { ascending: true })

  const trendByDay: Record<
    string,
    { date: string; positive: number; negative: number; neutral: number; total: number }
  > = {}
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

  // 6-day window for realtime insights and competitive mentions.
  const sixDaysAgoIso = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()
  const recentRows = rows.filter(
    (r: any) => r.published_at && r.published_at >= sixDaysAgoIso,
  )
  const normalizedRecent = recentRows.map((r: any) => ({
    id: r.observation_id,
    title: r.title,
    content: r.content ?? null,
    url: r.url ?? null,
    published_at: r.published_at ?? null,
    sentiment: (r.sentiment as Sentiment | null) ?? null,
    impact_score: (r.impact_score as number | null) ?? null,
    category: r.category_id ? categoryById.get(r.category_id) : null,
    source: r.source_id ? sourceById.get(r.source_id) : null,
  }))

  const realtimeInsights = computeRealtimeInsights(normalizedRecent)
  const competitiveMentions = computeCompetitiveMentions(normalizedRecent)
  const competitiveMentionsMeta = summarizeCompetitiveMentions(competitiveMentions)

  const { data: lastScrape } = await supabase
    .from("scrape_logs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
    .single()

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
  })
}
