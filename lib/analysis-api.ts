// Typed client for the analysis API.
//
// Default: same-origin Next.js API routes (/api/analysis/*) backed by the
// canonical codex-analysis JSON — works out of the box on Vercel.
// Override: set NEXT_PUBLIC_ANALYSIS_API_URL to hit the FastAPI backend
// instead (useful for local development or a separately deployed service).

const FASTAPI_OVERRIDE = process.env.NEXT_PUBLIC_ANALYSIS_API_URL

export const ANALYSIS_API_URL = FASTAPI_OVERRIDE ?? ""

// When talking to FastAPI we use /api/v1/* paths (legacy).
// When using same-origin Next.js routes we use /api/analysis/* paths.
const USE_FASTAPI = Boolean(FASTAPI_OVERRIDE)

export type Severity = "critical" | "high" | "medium" | "low"

export type TimelineStatus =
  | "baseline"
  | "emerging"
  | "crisis"
  | "peak_crisis"
  | "recovery"
  | "recovered"

export interface TimelinePoint {
  month: string
  sentiment: number
  issue_freq: number
  status: TimelineStatus
  note: string | null
}

export interface TimelineResponse {
  points: TimelinePoint[]
  peak_crisis: TimelinePoint
  peak_recovery: TimelinePoint
}

export interface UserSegment {
  id: string
  name: string
  slug: string
  description: string | null
  developer_count_range: string | null
  crisis_severity_percentage: number
  cost_impact_percentage: number
  recovery_speed_percentage: number
}

export interface RootCause {
  id: string
  product: string
  title: string
  description: string | null
  component: string | null
  error_type: string | null
  severity: Severity
  first_detected: string | null
  identified_date: string | null
  fixed_date: string | null
  fixed_in_version: string | null
  estimated_users_impacted_percentage: number
  affected_issue_count: number
}

export interface Category {
  id: string
  name: string
  slug: string
  color: string
  tier: 1 | 2 | 3
  share_pct: number
  users_affected_pct: number
  summary: string | null
  cascades_to: string[]
  action: string | null
}

export interface TierBreakdown {
  tier: 1 | 2 | 3
  category_count: number
  total_share_pct: number
  total_users_affected_pct: number
  categories: Category[]
}

export interface PainPoint {
  category: Category
  issue_count: number
  avg_sentiment: number
  critical_count: number
  high_count: number
  pain_score: number
  rank: number
}

export interface SentimentBucket {
  bucket: string
  count: number
}

export interface SentimentAnalytics {
  distribution: SentimentBucket[]
  trend: TimelinePoint[]
  stats: {
    count: number
    mean: number
    stddev: number
    min: number
    max: number
  }
}

export interface CategoryTimeseriesPoint {
  month: string
  issue_count: number
  sentiment: number
  status: TimelineStatus
}

export interface CompetitiveRow {
  id: string
  product: string
  display_name: string
  code_quality_score: number
  efficiency_score: number
  cost_per_task_usd: number
  context_window_tokens: number
  agent_autonomy_score: number
  market_sentiment: number
  adoption_rate: number
  enterprise_readiness_score: number
  summary: string | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ANALYSIS_API_URL}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    throw new Error(`Analysis API ${res.status}: ${path}`)
  }
  return (await res.json()) as T
}

// Endpoint routing per mode. Keeps this the single place that knows about
// the shape difference between FastAPI and the Next.js routes.
const PATHS = USE_FASTAPI
  ? {
      timeline: "/api/v1/timeline",
      segments: "/api/v1/user-segments",
      rootCauses: "/api/v1/root-causes",
      competitive: "/api/v1/analytics/competitive",
      categories: "/api/v1/categories",
      catTimeseries: (slug: string) => `/api/v1/categories/${slug}/timeseries`,
      tiers: "/api/v1/analytics/tiers",
      painPoints: (limit: number) => `/api/v1/analytics/pain-points?limit=${limit}`,
      sentiment: "/api/v1/analytics/sentiment",
    }
  : {
      timeline: "/api/analysis/timeline",
      segments: "/api/analysis/user-segments",
      rootCauses: "/api/analysis/root-causes",
      competitive: "/api/analysis/competitive",
      categories: "/api/analysis/categories",
      catTimeseries: (slug: string) => `/api/analysis/categories/${slug}/timeseries`,
      tiers: "/api/analysis/tiers",
      painPoints: (limit: number) => `/api/analysis/pain-points?limit=${limit}`,
      sentiment: "/api/analysis/sentiment",
    }

export const analysisApi = {
  timeline: () => request<TimelineResponse>(PATHS.timeline),
  segments: () => request<UserSegment[]>(PATHS.segments),
  rootCauses: () => request<RootCause[]>(PATHS.rootCauses),
  competitive: () => request<CompetitiveRow[]>(PATHS.competitive),
  categories: () => request<Category[]>(PATHS.categories),
  categoryTimeseries: (slug: string) =>
    request<{
      category: Category
      points: CategoryTimeseriesPoint[]
      peak: CategoryTimeseriesPoint
      recovery: CategoryTimeseriesPoint
    }>(PATHS.catTimeseries(slug)),
  tiers: () => request<TierBreakdown[]>(PATHS.tiers),
  painPoints: (limit = 5) => request<PainPoint[]>(PATHS.painPoints(limit)),
  sentiment: () => request<SentimentAnalytics>(PATHS.sentiment),
}
