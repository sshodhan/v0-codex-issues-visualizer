import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

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

interface InsightIssue {
  id: string
  title: string
  url: string | null
  source: string
  impact_score: number
}

function firstRelation<T>(value: T[] | T | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? value[0] || null : value
}

export async function GET() {
  const supabase = await createClient()

  // Get total counts
  const { count: totalIssues } = await supabase
    .from("issues")
    .select("*", { count: "exact", head: true })

  // Get sentiment breakdown
  const { data: sentimentData } = await supabase.from("issues").select("sentiment")

  const sentimentCounts = {
    positive: 0,
    negative: 0,
    neutral: 0,
  }
  sentimentData?.forEach((issue: { sentiment: Sentiment | null }) => {
    if (issue.sentiment) {
      sentimentCounts[issue.sentiment as keyof typeof sentimentCounts]++
    }
  })

  // Get source breakdown
  const { data: sourceData } = await supabase.from("issues").select(`
    source:sources(name, slug)
  `)

  const sourceCounts: Record<string, number> = {}
  sourceData?.forEach((issue: SourceJoin) => {
    const sourceName = firstRelation(issue.source)?.name || "Unknown"
    sourceCounts[sourceName] = (sourceCounts[sourceName] || 0) + 1
  })

  // Get category breakdown
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

  // Get trend data (issues per day for last 30 days)
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
        trendByDay[date][issue.sentiment as "positive" | "negative" | "neutral"]++
      }
    }
  })

  // Get priority matrix data (impact vs frequency)
  const { data: priorityData } = await supabase.from("issues").select(`
    id,
    title,
    impact_score,
    frequency_count,
    sentiment,
    category:categories(name, color)
  `)

  // Real-time issue signals (engineer-focused "what to fix now")
  const sixDaysAgo = new Date()
  sixDaysAgo.setDate(sixDaysAgo.getDate() - 6)
  const threeDaysAgo = new Date()
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)

  const { data: insightIssues } = await supabase.from("issues").select(`
    id,
    title,
    url,
    published_at,
    sentiment,
    impact_score,
    category:categories(name, slug, color),
    source:sources(name, slug)
  `)
    .gte("published_at", sixDaysAgo.toISOString())
    .order("published_at", { ascending: false })

  const insightBuckets: Record<
    string,
    {
      category: { name: string; slug: string; color: string }
      nowCount: number
      previousCount: number
      negativeCount: number
      impactTotal: number
      samples: InsightIssue[]
    }
  > = {}

  insightIssues?.forEach((issue: {
    id: string
    title: string
    url: string | null
    published_at: string | null
    sentiment: Sentiment | null
    impact_score: number | null
    category:
      | { name: string; slug: string; color: string }[]
      | { name: string; slug: string; color: string }
      | null
    source: { name: string; slug: string }[] | { name: string; slug: string } | null
  }) => {
    const category = firstRelation(issue.category)
    if (!issue.published_at || !category) return

    const publishedAt = new Date(issue.published_at)
    const categoryKey = category.slug
    const bucket = insightBuckets[categoryKey] || {
      category,
      nowCount: 0,
      previousCount: 0,
      negativeCount: 0,
      impactTotal: 0,
      samples: [],
    }

    const isNowWindow = publishedAt >= threeDaysAgo
    if (isNowWindow) {
      bucket.nowCount++
      bucket.impactTotal += issue.impact_score || 0
      if (issue.sentiment === "negative") bucket.negativeCount++
      bucket.samples.push({
        id: issue.id,
        title: issue.title,
        url: issue.url,
        source: firstRelation(issue.source)?.name || "Unknown",
        impact_score: issue.impact_score || 0,
      })
    } else {
      bucket.previousCount++
    }

    insightBuckets[categoryKey] = bucket
  })

  const realtimeInsights = Object.values(insightBuckets)
    .map((bucket) => {
      const momentum = bucket.nowCount - bucket.previousCount
      const avgImpact = bucket.nowCount > 0 ? bucket.impactTotal / bucket.nowCount : 0
      const negativeRatio = bucket.nowCount > 0 ? bucket.negativeCount / bucket.nowCount : 0
      const urgencyScore = Number(
        (
          bucket.nowCount * 1.8 +
          Math.max(momentum, 0) * 1.5 +
          avgImpact * 1.1 +
          negativeRatio * 3
        ).toFixed(2)
      )

      return {
        category: bucket.category,
        nowCount: bucket.nowCount,
        previousCount: bucket.previousCount,
        momentum,
        avgImpact: Number(avgImpact.toFixed(2)),
        negativeRatio: Number((negativeRatio * 100).toFixed(1)),
        urgencyScore,
        topIssues: bucket.samples
          .sort((a, b) => b.impact_score - a.impact_score)
          .slice(0, 3),
      }
    })
    .filter((bucket) => bucket.nowCount > 0)
    .sort((a, b) => b.urgencyScore - a.urgencyScore)
    .slice(0, 5)

  // Get last scrape info
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
    trendData: Object.values(trendByDay),
    priorityMatrix: priorityData || [],
    realtimeInsights,
    lastScrape,
  })
}
