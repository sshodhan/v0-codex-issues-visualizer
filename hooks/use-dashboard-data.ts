"use client"

import useSWR from "swr"
import type { PrerequisiteStatus } from "@/lib/classification/prerequisites"
import type { PipelineStateSummary } from "@/lib/classification/pipeline-state"

export type { PrerequisiteStatus }

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
  /** Latest LLM `classifications.category` on MV rows in the same `totalIssues` window (v14+ /api/stats). */
  llmCategoryBreakdown?: Array<{ name: string; count: number }>
  llmClassifiedInWindow?: number
  llmPendingInWindow?: number
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
    /** LLM-category breakdown of `nowCount` (v15+ /api/stats; older payloads omit). */
    llmCategoryBreakdown?: Array<{ slug: string; count: number }>
    /** Count of `nowCount` rows with no LLM classification yet (v15+ /api/stats). */
    llmUnclassifiedCount?: number
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
  /** Present when read from mv_observation_current */
  cluster_id?: string | null
  cluster_key?: string | null
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
  // `window_hours` is the request param echoed back; `window_days` is the
  // actual comparison unit (the SQL function rounds hours up to whole
  // calendar days because mv_fingerprint_daily is day-granular). The card
  // renders copy based on window_days so the UI claim matches the data.
  window_hours?: number
  window_days?: number
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
      refreshInterval: options?.asOf ? 0 : 180000, // Disable auto-refresh in replay mode
    }
  )

  return {
    stats: data,
    isLoading,
    isError: error,
    refresh: mutate,
  }
}

export interface ClusterRollupRow {
  id: string
  count: number
  classified_count: number
  reviewed_count: number
  source_count?: number
  label: string | null
  label_confidence: number | null
  representative_title?: string | null
  representative_observation_id?: string | null
  why_surfaced?: string | null
  rail_scoring?: {
    actionability_input: number
    surge_input: number
    review_pressure_input: number
    rail_tags: Array<"actionability" | "surge" | "review_pressure">
  }
  cluster_path: "semantic" | "fallback"
  fingerprint_hit_rate: number
  dominant_error_code_share: number
  dominant_stack_frame_share: number
  intra_cluster_similarity_proxy: number
  nearest_cluster_gap_proxy: number
  classified_share?: number
  human_reviewed_share?: number
  avg_impact?: number | null
  regex_variants?: Array<{ kind: "err" | "stack" | "env" | "sdk"; value: string }>
  breadth?: { sources: Record<string, number>; os: string[] }
  // Tier 2A — truth-first V3 card fidelity. All optional so stale SWR
  // caches from older deploys render cleanly. Gating rules enforced
  // server-side in app/api/clusters/rollup/route.ts — the server sets
  // the *_pct / dominant_* fields to null when the underlying sample
  // is too small to be meaningful.
  severity_distribution?: { low: number; medium: number; high: number; critical: number }
  dominant_severity?: "low" | "medium" | "high" | "critical" | null
  sentiment_distribution?: { positive: number; neutral: number; negative: number }
  negative_sentiment_pct?: number | null
  surge_delta_pct?: number | null
  surge_window_hours?: number
  recent_window_count?: number
  prior_window_count?: number
}

/**
 * Top semantic clusters in the current dashboard window (Layer A on mv_observation_current),
 * for Story tab and drill-down affordances. Read-only.
 */
export function useClusterRollup(options: { days?: number; category: string }) {
  const params = new URLSearchParams()
  if (options.days) params.set("days", String(options.days))
  if (options.category && options.category !== "all") params.set("category", options.category)
  const qs = params.toString()
  const url = qs ? `/api/clusters/rollup?${qs}` : "/api/clusters/rollup"
  const { data, error, isLoading, mutate } = useSWR<{
    clusters: ClusterRollupRow[]
    pipeline_state: PipelineStateSummary
  }>(url, fetcher, { refreshInterval: 300_000 })
  return { data, isLoading, isError: error, refresh: mutate }
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
  /** Layer-A cluster filter (read-time); UUID */
  cluster_id?: string
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
  if (filters?.cluster_id) params.set("cluster_id", filters.cluster_id)
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

export interface ClusterSample {
  observation_id: string
  title: string
  url: string | null
  impact_score: number
  sentiment: string | null
}

export interface ClusterSummary {
  id: string
  cluster_key: string
  label: string | null
  label_confidence: number | null
  size: number
  in_window: number
  classified_count: number
  reviewed_count: number
  cluster_path: "semantic" | "fallback"
  fingerprint_hit_rate: number
  dominant_error_code_share: number
  dominant_stack_frame_share: number
  intra_cluster_similarity_proxy: number
  nearest_cluster_gap_proxy: number
  samples: ClusterSample[]
}

export interface ClustersResponse {
  clusters: ClusterSummary[]
  windowDays: number | null
  source: "observations"
  pipeline_state: PipelineStateSummary
}

// Direct cluster read from /api/clusters, independent of the
// classification pipeline. Powers the semantic-cluster chip strip on
// the triage tab so clusters are visible even when 0 classifications
// have been generated yet. See docs/CLUSTERING_DESIGN.md §7.
export function useClusters(options?: { days?: number; limit?: number; asOf?: string }) {
  const params = new URLSearchParams()
  if (options?.days) params.set("days", String(options.days))
  if (options?.limit) params.set("limit", String(options.limit))
  // as_of intentionally NOT forwarded: clusters carry no derivation
  // timestamp, so point-in-time replay on cluster state is a separate
  // design problem (see CLUSTERING_DESIGN.md §6.3).
  void options?.asOf
  const url = `/api/clusters${params.toString() ? `?${params.toString()}` : ""}`

  const { data, error, isLoading, mutate } = useSWR<ClustersResponse>(url, fetcher, {
    refreshInterval: 60000,
  })

  return {
    clusters: data?.clusters ?? [],
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
    refreshInterval: 180000,
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
  // subcategory override landed in 020_classification_reviews_add_subcategory.sql.
  // Pre-020 rows are null; the API resolves null → baseline classifications.subcategory.
  subcategory: string | null
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
  // LLM schema enums (lib/classification/schema.ts). Required by the JSON
  // schema but kept nullable here because pre-schema-lock rows in
  // production may have null values until reclassified.
  reproducibility: "always" | "often" | "sometimes" | "once" | "unknown" | null
  impact: "single-user" | "team" | "org" | "fleet" | "unknown" | null
  confidence: number
  summary: string
  root_cause_hypothesis: string | null
  suggested_fix: string | null
  evidence_quotes: string[]
  alternate_categories: string[]
  tags: string[]
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
  effective_subcategory: string
  effective_severity: string
  effective_needs_human_review: boolean
  // Traceability fields — sourced from the linked observation at response time,
  // not stored on the classification row. See docs/ARCHITECTURE.md v10 §7.2.
  source_issue_url: string | null
  source_issue_title: string | null
  source_issue_sentiment: "positive" | "negative" | "neutral" | null
  // Semantic-cluster identity for the linked observation. Null when the
  // observation has no cluster membership (clustering hasn't run, embedding
  // failed, or below the cosine threshold). `cluster_key` prefix distinguishes
  // `semantic:<digest>` (real clustering) from `title:<md5>` (fallback); it
  // is an implementation detail and should not be rendered to users — use
  // `cluster_label` with an "Unlabelled cluster" placeholder instead.
  cluster_id: string | null
  cluster_key: string | null
  cluster_label: string | null
  cluster_label_confidence: number | null
  cluster_size: number | null
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
  // Optional so older server payloads during deploy don't break the
  // type contract. null (not undefined) indicates the prereq fetch
  // failed server-side — UI should fall back to the generic
  // "No AI classifications yet" copy in that case.
  prerequisites?: PrerequisiteStatus | null
  pipeline_state?: PipelineStateSummary
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
    { refreshInterval: filters?.asOf ? 0 : 180000 } // Disable auto-refresh in replay mode
  )

  return {
    classifications: data?.data || [],
    isLoading,
    isError: error,
    refresh: mutate,
  }
}

export function useClassificationStats(options?: { asOf?: string; days?: number }) {
  const params = new URLSearchParams()
  if (options?.asOf) params.set("as_of", options.asOf)
  if (options?.days) params.set("days", String(options.days))
  const queryString = params.toString()
  const url = queryString ? `/api/classifications/stats?${queryString}` : "/api/classifications/stats"

  const { data, error, isLoading, mutate } = useSWR<ClassificationStats>(
    url,
    fetcher,
    { refreshInterval: options?.asOf ? 0 : 180000 }
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
    subcategory?: string
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
