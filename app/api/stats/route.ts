import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { computeRealtimeInsights } from "@/lib/analytics/realtime"
import {
  computeCompetitiveMentions,
  summarizeCompetitiveMentions,
} from "@/lib/analytics/competitive"

type Sentiment = "positive" | "negative" | "neutral"

interface SourceJoin {
  source: { name: string; slug: string }[] | { name: string; slug: string } | null
}

interface CategoryJoin {
  category:
    | { name: string; slug: string; color: string }[]
    | { name: string; slug: string; color: string }
    | null
}

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

function firstRelation<T>(value: T[] | T | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? value[0] || null : value
}

export async function GET() {
  const supabase = await createClient()

  const { count: totalIssues } = await supabase
    .from("issues")
    .select("*", { count: "exact", head: true })

  const { data: sentimentData } = await supabase.from("issues").select("sentiment")

  const sentimentCounts = { positive: 0, negative: 0, neutral: 0 }
  sentimentData?.forEach((issue: { sentiment: Sentiment | null }) => {
    if (issue.sentiment) {
      sentimentCounts[issue.sentiment as keyof typeof sentimentCounts]++
    }
  })

  const { data: sourceData } = await supabase.from("issues").select(`
    source:sources(name, slug)
  `)

  const sourceCounts: Record<string, number> = {}
  sourceData?.forEach((issue: SourceJoin) => {
    const sourceName = firstRelation(issue.source)?.name || "Unknown"
    sourceCounts[sourceName] = (sourceCounts[sourceName] || 0) + 1
  })

  const { data: categoryData } = await supabase.from("issues").select(`
    category:categories(name, slug, color)
  `)

  const categoryCounts: Record<string, { count: number; color: string }> = {}
  categoryData?.forEach((issue: CategoryJoin) => {
    const cat = firstRelation(issue.category)
    if (cat) {
      if (!categoryCounts[cat.name]) {
        categoryCounts[cat.name] = { count: 0, color: cat.color }
      }
      categoryCounts[cat.name].count++
    }
  })

  const { data: categorySentimentData } = await supabase.from("issues").select(`
    title,
    url,
    sentiment,
    impact_score,
    category:categories(name, slug, color)
  `)

  const categorySentimentMap: Record<string, CategorySentimentAccumulator> = {}
  categorySentimentData?.forEach((issue) => {
    const category = firstRelation(issue.category as CategoryJoin["category"])
    if (!category) return

    if (!categorySentimentMap[category.name]) {
      categorySentimentMap[category.name] = {
        name: category.name,
        color: category.color,
        positive: 0,
        neutral: 0,
        negative: 0,
        total: 0,
        impactSum: 0,
        topIssue: null,
      }
    }

    const bucket = categorySentimentMap[category.name]
    const sentiment = issue.sentiment as Sentiment | null
    if (sentiment) {
      bucket[sentiment] += 1
    }
    bucket.total += 1
    const issueImpact = Number(issue.impact_score) || 0
    bucket.impactSum += issueImpact

    if (!bucket.topIssue || issueImpact > bucket.topIssue.impact_score) {
      bucket.topIssue = {
        title: (issue.title as string) || "Untitled issue",
        url: (issue.url as string | null) ?? null,
        impact_score: issueImpact,
      }
    }
  })

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

  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const { data: trendData } = await supabase
    .from("issues")
    .select("published_at, sentiment")
    .gte("published_at", thirtyDaysAgo.toISOString())
    .order("published_at", { ascending: true })

  const trendByDay: Record<
    string,
    { date: string; positive: number; negative: number; neutral: number; total: number }
  > = {}

  trendData?.forEach((issue) => {
    if (issue.published_at) {
      const date = issue.published_at.split("T")[0]
      if (!trendByDay[date]) {
        trendByDay[date] = { date, positive: 0, negative: 0, neutral: 0, total: 0 }
      }
      trendByDay[date].total++
      if (issue.sentiment) {
        trendByDay[date][issue.sentiment as Sentiment]++
      }
    }
  })

  const { data: priorityData } = await supabase.from("issues").select(`
    id,
    title,
    impact_score,
    frequency_count,
    sentiment,
    category:categories(name, color)
  `)

  // Pull a single 6-day window once and split it for both realtime insights
  // and recent competitive mentions (avoids duplicate queries).
  const sixDaysAgo = new Date()
  sixDaysAgo.setDate(sixDaysAgo.getDate() - 6)

  const { data: recentIssues } = await supabase
    .from("issues")
    .select(`
      id,
      title,
      content,
      url,
      published_at,
      sentiment,
      impact_score,
      category:categories(name, slug, color),
      source:sources(name, slug)
    `)
    .gte("published_at", sixDaysAgo.toISOString())
    .order("published_at", { ascending: false })

  const normalizedRecent = (recentIssues || []).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    content: (row.content as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    published_at: (row.published_at as string | null) ?? null,
    sentiment: (row.sentiment as Sentiment | null) ?? null,
    impact_score: (row.impact_score as number | null) ?? null,
    category: firstRelation(row.category as CategoryJoin["category"]),
    source: firstRelation(row.source as SourceJoin["source"]),
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
    totalIssues: totalIssues || 0,
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
    priorityMatrix: priorityData || [],
    realtimeInsights,
    competitiveMentions,
    competitiveMentionsMeta,
    lastScrape,
  })
}
