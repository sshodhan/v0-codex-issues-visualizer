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
  realtimeInsights: Array<{
    category: { name: string; slug: string; color: string }
    nowCount: number
    previousCount: number
    momentum: number
    avgImpact: number
    negativeRatio: number
    urgencyScore: number
    topIssues: Array<{
      id: string
      title: string
      url: string | null
      source: string
      impact_score: number
    }>
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


export interface ClassificationRecord {
  id: string
  category: string
  subcategory: string
  severity: "critical" | "high" | "medium" | "low"
  status: "new" | "triaged" | "in-progress" | "resolved" | "wont-fix" | "duplicate"
  confidence: number
  summary: string
  evidence_quotes: string[]
  alternate_categories: string[]
  needs_human_review: boolean
  review_reasons: string[]
  source_issue_title: string | null
  source_issue_url: string | null
  source_issue_sentiment: "positive" | "negative" | "neutral" | null
  created_at: string
  reviewed_at: string | null
  reviewed_by: string | null
  reviewer_notes: string | null
}

export interface ClassificationStats {
  total: number
  needsReviewCount: number
  traceableCount: number
  traceabilityCoverage: number
  byCategory: Record<string, number>
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  bySentiment: Record<string, number>
}

export function useClassifications(filters?: {
  status?: string
  category?: string
  needs_human_review?: boolean
  limit?: number
}) {
  const params = new URLSearchParams()
  if (filters?.status) params.set("status", filters.status)
  if (filters?.category) params.set("category", filters.category)
  if (typeof filters?.needs_human_review === "boolean") params.set("needs_human_review", String(filters.needs_human_review))
  if (filters?.limit) params.set("limit", String(filters.limit))

  const { data, error, isLoading, mutate } = useSWR<{ data: ClassificationRecord[] }>(
    `/api/classifications?${params.toString()}`,
    fetcher,
    { refreshInterval: 60000 }
  )

  return {
    classifications: data?.data || [],
    isLoading,
    isError: error,
    refresh: mutate,
  }
}

export function useClassificationStats() {
  const { data, error, isLoading, mutate } = useSWR<ClassificationStats>(
    "/api/classifications/stats",
    fetcher,
    { refreshInterval: 60000 }
  )

  return {
    classificationStats: data,
    isLoading,
    isError: error,
    refresh: mutate,
  }
}

export async function reviewClassification(
  id: string,
  payload: {
    status?: "new" | "triaged" | "in-progress" | "resolved" | "wont-fix" | "duplicate"
    category?: string
    severity?: "critical" | "high" | "medium" | "low"
    needs_human_review?: boolean
    reviewer_notes?: string
    reviewed_by?: string
  }
) {
  const response = await fetch(`/api/classifications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Failed to update classification: ${response.status}`)
  }

  return response.json()
}
