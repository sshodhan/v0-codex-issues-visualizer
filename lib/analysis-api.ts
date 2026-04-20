// Typed client for the FastAPI analysis backend.
// Configure NEXT_PUBLIC_ANALYSIS_API_URL (default: http://localhost:8000).

export const ANALYSIS_API_URL =
  process.env.NEXT_PUBLIC_ANALYSIS_API_URL ?? "http://localhost:8000"

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

export const analysisApi = {
  timeline: () => request<TimelineResponse>("/api/v1/timeline"),
  segments: () => request<UserSegment[]>("/api/v1/user-segments"),
  rootCauses: () => request<RootCause[]>("/api/v1/root-causes"),
  competitive: () => request<CompetitiveRow[]>("/api/v1/analytics/competitive"),
}
