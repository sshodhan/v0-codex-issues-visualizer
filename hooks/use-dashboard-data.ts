"use client"

import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

export interface DashboardStats {
  totalIssues: number
  sentimentBreakdown: {
    positive: number
    negative: number
    neutral: number
  }
  sourceBreakdown: Array<{ name: string; count: number }>
  categoryBreakdown: Array<{ name: string; count: number; color: string }>
  trendData: Array<{
    date: string
    positive: number
    negative: number
    neutral: number
    total: number
  }>
  priorityMatrix: Array<{
    id: string
    title: string
    impact_score: number
    frequency_count: number
    sentiment: string
    category: { name: string; color: string } | null
  }>
  lastScrape: {
    status: string
    started_at: string
    completed_at: string
    issues_found: number
    issues_added: number
  } | null
}

export interface Issue {
  id: string
  title: string
  content: string
  url: string
  author: string
  sentiment: "positive" | "negative" | "neutral"
  sentiment_score: number
  impact_score: number
  frequency_count: number
  upvotes: number
  comments_count: number
  published_at: string
  source: { name: string; slug: string; icon: string } | null
  category: { name: string; slug: string; color: string } | null
}

export function useDashboardStats() {
  const { data, error, isLoading, mutate } = useSWR<DashboardStats>(
    "/api/stats",
    fetcher,
    {
      refreshInterval: 60000, // Refresh every minute
    }
  )

  return {
    stats: data,
    isLoading,
    isError: error,
    refresh: mutate,
  }
}

export function useIssues(filters?: {
  source?: string
  category?: string
  sentiment?: string
  days?: number
  sortBy?: string
  order?: string
}) {
  const params = new URLSearchParams()
  if (filters?.source) params.set("source", filters.source)
  if (filters?.category) params.set("category", filters.category)
  if (filters?.sentiment) params.set("sentiment", filters.sentiment)
  if (filters?.days) params.set("days", filters.days.toString())
  if (filters?.sortBy) params.set("sortBy", filters.sortBy)
  if (filters?.order) params.set("order", filters.order)

  const { data, error, isLoading, mutate } = useSWR<{
    data: Issue[]
    count: number
  }>(`/api/issues?${params.toString()}`, fetcher)

  return {
    issues: data?.data || [],
    count: data?.count || 0,
    isLoading,
    isError: error,
    refresh: mutate,
  }
}

export function useScrape() {
  const scrape = async () => {
    const response = await fetch("/api/scrape", { method: "POST" })
    return response.json()
  }

  return { scrape }
}
