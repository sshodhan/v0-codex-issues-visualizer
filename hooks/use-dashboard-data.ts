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
  categorySentimentBreakdown: Array<{
    name: string
    color: string
    positive: number
    neutral: number
    negative: number
    total: number
    avgImpact: number
    topIssue: {
      title: string
      url: string | null
      impact_score: number
    } | null
  }>
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
    sourceDiversity: number
    urgencyScore: number
    topIssues: Array<{
      id: string
      title: string
      url: string | null
      source: string
      impact_score: number
    }>
  }>
  competitiveMentions: Array<{
    competitor: string
    totalMentions: number
    rawMentions: number
    scoredMentions: number
    coverage: number
    avgConfidence: number
    positive: number
    negative: number
    neutral: number
    netSentiment: number
    topIssues: Array<{
      id: string
      title: string
      url: string | null
      sentiment: "positive" | "negative" | "neutral" | null
      confidence: number
      impact_score: number
    }>
  }>
  competitiveMentionsMeta: {
    competitorsTracked: number
    mentionCoverage: number
    avgConfidence: number
    totalScoredMentions: number
  }
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
  q?: string
}) {
  const params = new URLSearchParams()
  if (filters?.source) params.set("source", filters.source)
  if (filters?.category) params.set("category", filters.category)
  if (filters?.sentiment) params.set("sentiment", filters.sentiment)
  if (filters?.days) params.set("days", filters.days.toString())
  if (filters?.sortBy) params.set("sortBy", filters.sortBy)
  if (filters?.order) params.set("order", filters.order)
  if (filters?.q) params.set("q", filters.q)

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


export interface ClassificationReviewRecord {
  id: string
  classification_id: string
  status: string | null
  category: string | null
  severity: string | null
  needs_human_review: boolean | null
  reviewer_notes: string | null
  reviewed_by: string
  reviewed_at: string
}

export interface ClassificationRecord {
  id: string
  observation_id: string | null
  prior_classification_id: string | null
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
  model_used: string | null
  retried_with_large_model: boolean
  algorithm_version: string
  created_at: string
  // Append-only review history (see docs/ARCHITECTURE.md v10 §§3.3, 5.2):
  latest_review: ClassificationReviewRecord | null
  effective_status: string
  effective_category: string
  effective_severity: string
  effective_needs_human_review: boolean
  // Traceability fields — sourced from the linked observation at response time,
  // not stored on the classification row. See docs/ARCHITECTURE.md v10 §7.2.
  source_issue_url: string | null
  source_issue_title: string | null
  source_issue_sentiment: "positive" | "negative" | "neutral" | null
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
