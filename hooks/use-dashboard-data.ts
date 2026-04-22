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
    content?: string | null
    url?: string | null
    impact_score: number
    frequency_count: number
    source_diversity: number
    actionability: number
    priorityScore: number
    cluster_key_compound?: string | null
    sentiment: string
    category: { name: string; color: string } | null
    fingerprint?: {
      error_code: string | null
      top_stack_frame: string | null
      top_stack_frame_hash: string | null
      cli_version: string | null
      os: string | null
      shell: string | null
      editor: string | null
      model_id: string | null
      repro_markers: number
      keyword_presence: number
      llm_subcategory: string | null
      llm_primary_tag: string | null
      algorithm_version: string | null
    } | null
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
  // v3 bug-fingerprint projection — forwarded by /api/issues via
  // mv_observation_current. Null when the fingerprint backfill hasn't
  // reached this row yet.
  error_code?: string | null
  top_stack_frame?: string | null
  top_stack_frame_hash?: string | null
  cli_version?: string | null
  fp_os?: string | null
  fp_shell?: string | null
  fp_editor?: string | null
  model_id?: string | null
  repro_markers?: number | null
  fp_keyword_presence?: number | null
  llm_subcategory?: string | null
  llm_primary_tag?: string | null
  fingerprint_algorithm_version?: string | null
  cluster_key_compound?: string | null
}

export interface FingerprintSurgeRow {
  error_code: string
  now_count: number
  prev_count: number
  delta: number
  sources: number
}

export interface FingerprintSurgeNewRow {
  error_code: string
  count: number
  sources: number
}

export interface FingerprintSurgeResponse {
  surges: FingerprintSurgeRow[]
  new_in_window: FingerprintSurgeNewRow[]
}

export function useDashboardStats(options?: {
  days?: number
  category?: string
  asOf?: string
}) {
  const params = new URLSearchParams()
  if (options?.days) params.set("days", String(options.days))
  if (options?.category && options.category !== "all") params.set("category", options.category)
  if (options?.asOf) params.set("as_of", options.asOf)
  const queryString = params.toString()
  const url = queryString ? `/api/stats?${queryString}` : "/api/stats"

  const { data, error, isLoading, mutate } = useSWR<DashboardStats>(
    url,
    fetcher,
    {
      refreshInterval: options?.asOf ? 0 : 60000, // Disable auto-refresh in replay mode
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
  compound_key?: string
  asOf?: string
}) {
  const params = new URLSearchParams()
  if (filters?.source) params.set("source", filters.source)
  if (filters?.category) params.set("category", filters.category)
  if (filters?.sentiment) params.set("sentiment", filters.sentiment)
  if (filters?.days) params.set("days", filters.days.toString())
  if (filters?.sortBy) params.set("sortBy", filters.sortBy)
  if (filters?.order) params.set("order", filters.order)
  if (filters?.q) params.set("q", filters.q)
  if (filters?.compound_key) params.set("compound_key", filters.compound_key)
  if (filters?.asOf) params.set("as_of", filters.asOf)

  const { data, error, isLoading, mutate } = useSWR<{
    data: Issue[]
    count: number
  }>(`/api/issues?${params.toString()}`, fetcher, {
    refreshInterval: filters?.asOf ? 0 : undefined, // Disable auto-refresh in replay mode
  })

  return {
    issues: data?.data || [],
    count: data?.count || 0,
    isLoading,
    isError: error,
    refresh: mutate,
  }
}

// Surfaces the top fingerprint surges over the given rolling window. The
// backing route calls the `fingerprint_surges` SQL function introduced in
// migration 014; the shape is `{ surges, new_in_window }` and matches the
// FingerprintSurgeCard's read-only contract.
export function useFingerprintSurges(windowHours = 24) {
  const url = `/api/fingerprints/surge?window_hours=${windowHours}`
  const { data, error, isLoading, mutate } = useSWR<FingerprintSurgeResponse>(url, fetcher, {
    refreshInterval: 60000,
  })

  return {
    data,
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
  asOf?: string
}) {
  const params = new URLSearchParams()
  if (filters?.status) params.set("status", filters.status)
  if (filters?.category) params.set("category", filters.category)
  if (typeof filters?.needs_human_review === "boolean") params.set("needs_human_review", String(filters.needs_human_review))
  if (filters?.limit) params.set("limit", String(filters.limit))
  if (filters?.asOf) params.set("as_of", filters.asOf)

  const { data, error, isLoading, mutate } = useSWR<{ data: ClassificationRecord[] }>(
    `/api/classifications?${params.toString()}`,
    fetcher,
    { refreshInterval: filters?.asOf ? 0 : 60000 } // Disable auto-refresh in replay mode
  )

  return {
    classifications: data?.data || [],
    isLoading,
    isError: error,
    refresh: mutate,
  }
}

export function useClassificationStats(options?: { asOf?: string }) {
  const params = new URLSearchParams()
  if (options?.asOf) params.set("as_of", options.asOf)
  const queryString = params.toString()
  const url = queryString ? `/api/classifications/stats?${queryString}` : "/api/classifications/stats"

  const { data, error, isLoading, mutate } = useSWR<ClassificationStats>(
    url,
    fetcher,
    { refreshInterval: options?.asOf ? 0 : 60000 }
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
