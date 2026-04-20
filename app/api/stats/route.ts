import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

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
  sentimentData?.forEach((issue) => {
    if (issue.sentiment) {
      sentimentCounts[issue.sentiment as keyof typeof sentimentCounts]++
    }
  })

  // Get source breakdown
  const { data: sourceData } = await supabase.from("issues").select(`
    source:sources(name, slug)
  `)

  const sourceCounts: Record<string, number> = {}
  sourceData?.forEach((issue) => {
    const sourceName = (issue.source as { name: string } | null)?.name || "Unknown"
    sourceCounts[sourceName] = (sourceCounts[sourceName] || 0) + 1
  })

  // Get category breakdown
  const { data: categoryData } = await supabase.from("issues").select(`
    category:categories(name, slug, color)
  `)

  const categoryCounts: Record<string, { count: number; color: string }> = {}
  categoryData?.forEach((issue) => {
    const cat = issue.category as { name: string; color: string } | null
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
    lastScrape,
  })
}
