// Canonical market-analysis dataset adapter.
//
// The source of truth is codex-analysis/codex_analysis_data_detailed_by_category.json
// (produced by the upstream analysis pipeline). This module imports that
// JSON and enriches the category list with the TIER classification from
// CATEGORY_ANALYSIS_SUMMARY.md so every /api/analysis/* route speaks the
// same vocabulary as the Python backend.
//
// Vercel: these routes run as edge/node functions on same-origin, so the
// dashboard works out of the box once the repo is deployed — no separate
// FastAPI service required. Supabase becomes the data store in a later
// phase once the loader's `issue_categories` table carries tier columns.

import raw from "@/codex-analysis/codex_analysis_data_detailed_by_category.json"

export type Tier = 1 | 2 | 3

export interface Category {
  id: string
  name: string
  slug: string
  color: string
  tier: Tier
  share_pct: number
  users_affected_pct: number
  count: number
  severity_avg: string
  description: string | null
  summary: string | null
  cascades_to: string[]
  action: string | null
}

export interface UserSegment {
  slug: string
  name: string
  developer_count_range: string
  crisis_severity_percentage: number
  cost_impact_percentage: number
  recovery_speed_percentage: number
  description: string | null
}

export interface TimelinePoint {
  month: string // YYYY-MM-01
  sentiment: number
  issue_freq: number
  status: TimelineStatus
  note: string | null
}

export type TimelineStatus =
  | "baseline"
  | "emerging"
  | "crisis"
  | "peak_crisis"
  | "recovery"
  | "recovered"

export interface CategoryTimeseriesPoint {
  month: string // YYYY-MM-01
  issue_count: number
  sentiment: number
  engagement: number
  mention_count: number
  severity_critical: number
  severity_high: number
  severity_medium: number
  severity_low: number
}

export interface RootCause {
  id: string
  title: string
  description: string
  component: string | null
  error_type: string | null
  severity: string
  estimated_users_impacted_percentage: number
  affected_issue_count: number
  first_detected: string | null
  fixed_date: string | null
  fixed_in_version: string | null
}

export interface CompetitiveRow {
  product: string
  display_name: string
  code_quality_score: number
  efficiency_score: number
  cost_per_task_usd: number
  context_window_tokens: number
  agent_autonomy_score: number
  uptime_sla: number | null
  strengths: string[]
  weaknesses: string[]
}

// ---------- TIER enrichment (from CATEGORY_ANALYSIS_SUMMARY.md) -------------

const TIER_META: Record<
  string,
  {
    tier: Tier
    users_affected_pct: number
    slug: string
    color: string
    cascades_to?: string[]
    summary?: string
    action?: string
  }
> = {
  "Session/Memory Management": {
    tier: 1,
    users_affected_pct: 12,
    slug: "session-memory",
    color: "#ef4444",
    summary:
      "Recursive context compaction and memory leaks during long sessions.",
    action: "Highest priority — fixes 2+ cascading issues.",
  },
  "Token Counting Issues": {
    tier: 1,
    users_affected_pct: 8,
    slug: "token-counting",
    color: "#f97316",
    cascades_to: ["context-overflow"],
    summary:
      "Off-by-one error in tokenizer.py driving phantom billing and early quota exhaustion.",
    action: "Fixes Context Overflow cascade (80% of affected users).",
  },
  "Context Overflow": {
    tier: 1,
    users_affected_pct: 9,
    slug: "context-overflow",
    color: "#eab308",
    summary: "Silent tail truncation; symptom of token-counting drift.",
    action: "Largely resolves once Token Counting is fixed.",
  },
  "Code Review Incomplete": {
    tier: 2,
    users_affected_pct: 7,
    slug: "code-review-incomplete",
    color: "#8b5cf6",
    summary:
      "Persistent quality issue — model degradation at v1.8.0 dropping large-diff coverage.",
    action: "Pre-dates the crisis; needs dedicated model/eval workstream.",
  },
  "Regression in Output Quality": {
    tier: 2,
    users_affected_pct: 6,
    slug: "regression-quality",
    color: "#ec4899",
    summary: "Secondary quality degradation surfacing in agent outputs.",
    action: "Track against model release cadence; add automated regression evals.",
  },
  "Unexpected Behavior": {
    tier: 3,
    users_affected_pct: 4,
    slug: "unexpected-behavior",
    color: "#6b7280",
    summary:
      "Symptom category that masks underlying issues; slowest recovery curve.",
    action: "Root-cause triage — likely resolves alongside TIER 1 fixes.",
  },
  "API Rate Limiting": {
    tier: 3,
    users_affected_pct: 3,
    slug: "api-rate-limiting",
    color: "#3b82f6",
    summary:
      "Operational/config issue with highest sentiment; low user count but drove 92% enterprise cost impact.",
    action: "Quick win — ship retry/backoff fix + quota dashboards.",
  },
}

function slugifySegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function monthKey(label: string): string {
  // "Jan 2025" -> "2025-01-01"
  const [mon, year] = label.split(" ")
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  }
  return `${year}-${months[mon] ?? "01"}-01`
}

function timelineStatus(month: string): TimelineStatus {
  // Mirror the FastAPI shape.
  const m = month.slice(0, 7)
  if (["2025-01", "2025-02"].includes(m)) return "baseline"
  if (["2025-03", "2025-04", "2025-05"].includes(m)) return "emerging"
  if (["2025-06", "2025-07", "2025-08"].includes(m)) return "crisis"
  if (["2025-09", "2025-10"].includes(m)) return "peak_crisis"
  if (["2025-11", "2025-12", "2026-01", "2026-02"].includes(m)) return "recovery"
  return "recovered"
}

// ---------- Exports --------------------------------------------------------

type RawCategory = {
  id: number
  name: string
  count: number
  percentage: number
  severity_avg: string
  description: string
}

type RawTimelinePoint = {
  month: string
  sentiment?: number
  avg_sentiment?: number
  total_issues?: number
  issue_count?: number
  mention_count?: number
}

type RawCategoryPoint = {
  month: string
  sentiment: number
  issue_count: number
  engagement: number
  severity_critical: number
  severity_high: number
  severity_medium: number
  severity_low: number
  mention_count: number
}

type RawSegment = {
  name: string
  developer_count_range: string
  crisis_severity: number
  cost_impact: number
  recovery_speed: number
  description?: string
}

type RawRootCause = {
  id?: number | string
  title?: string
  name?: string
  description?: string
  component?: string
  error_type?: string
  severity?: string
  estimated_users_impacted_percentage?: number
  affected_issue_count?: number
  first_detected?: string
  fixed_date?: string
  fixed_in_version?: string
}

type RawCompetitive = {
  product: string
  code_quality_score?: number
  efficiency_score?: number
  cost_per_task?: number
  cost_per_task_usd?: number
  context_window_tokens?: number
  agent_autonomy_score?: number
  uptime_sla?: number
  strengths?: string[]
  weaknesses?: string[]
}

const rawData = raw as unknown as {
  issue_categories: RawCategory[]
  timeline_data: RawTimelinePoint[]
  timeline_data_by_category: Record<string, RawCategoryPoint[]>
  user_segments: RawSegment[]
  root_causes: RawRootCause[]
  competitive_analysis: RawCompetitive[]
}

export const CATEGORIES: Category[] = rawData.issue_categories.map((c) => {
  const meta = TIER_META[c.name]
  if (!meta) {
    throw new Error(`Missing TIER metadata for category: ${c.name}`)
  }
  return {
    id: `cat-${meta.slug}`,
    name: c.name,
    slug: meta.slug,
    color: meta.color,
    tier: meta.tier,
    share_pct: c.percentage,
    users_affected_pct: meta.users_affected_pct,
    count: c.count,
    severity_avg: c.severity_avg,
    description: c.description,
    summary: meta.summary ?? null,
    cascades_to: meta.cascades_to ?? [],
    action: meta.action ?? null,
  }
})

export const CATEGORY_BY_SLUG = Object.fromEntries(
  CATEGORIES.map((c) => [c.slug, c]),
)

export const USER_SEGMENTS: UserSegment[] = rawData.user_segments.map((s) => ({
  slug: slugifySegment(s.name),
  name: s.name,
  developer_count_range: s.developer_count_range,
  crisis_severity_percentage: s.crisis_severity,
  cost_impact_percentage: s.cost_impact,
  recovery_speed_percentage: s.recovery_speed,
  description: s.description ?? null,
}))

function pickSentiment(p: RawTimelinePoint): number {
  return typeof p.sentiment === "number"
    ? p.sentiment
    : typeof p.avg_sentiment === "number"
    ? p.avg_sentiment
    : 0
}

function pickFreq(p: RawTimelinePoint): number {
  return typeof p.total_issues === "number"
    ? p.total_issues
    : typeof p.issue_count === "number"
    ? p.issue_count
    : typeof p.mention_count === "number"
    ? p.mention_count
    : 0
}

export const TIMELINE: TimelinePoint[] = rawData.timeline_data.map((p) => {
  const month = monthKey(p.month)
  return {
    month,
    sentiment: pickSentiment(p),
    issue_freq: pickFreq(p),
    status: timelineStatus(month),
    note:
      month === "2025-10-01"
        ? "Crisis trough"
        : month === "2026-04-01"
        ? "Full recovery"
        : null,
  }
})

export function crisisTrough(): TimelinePoint {
  return TIMELINE.reduce((min, p) => (p.sentiment < min.sentiment ? p : min), TIMELINE[0])
}

export function recoveryPeak(): TimelinePoint {
  return TIMELINE.reduce((max, p) => (p.sentiment > max.sentiment ? p : max), TIMELINE[0])
}

export function categoryTimeseries(slug: string): CategoryTimeseriesPoint[] | null {
  const cat = CATEGORY_BY_SLUG[slug]
  if (!cat) return null
  const rows = rawData.timeline_data_by_category[cat.name]
  if (!rows) return null
  return rows.map((r) => ({
    month: monthKey(r.month),
    issue_count: r.issue_count,
    sentiment: r.sentiment,
    engagement: r.engagement,
    mention_count: r.mention_count,
    severity_critical: r.severity_critical,
    severity_high: r.severity_high,
    severity_medium: r.severity_medium,
    severity_low: r.severity_low,
  }))
}

export const ROOT_CAUSES: RootCause[] = rawData.root_causes.map((r, idx) => ({
  id: String(r.id ?? `rc-${idx + 1}`),
  title: r.title ?? r.name ?? "Untitled root cause",
  description: r.description ?? "",
  component: r.component ?? null,
  error_type: r.error_type ?? null,
  severity: r.severity ?? "medium",
  estimated_users_impacted_percentage: r.estimated_users_impacted_percentage ?? 0,
  affected_issue_count: r.affected_issue_count ?? 0,
  first_detected: r.first_detected ?? null,
  fixed_date: r.fixed_date ?? null,
  fixed_in_version: r.fixed_in_version ?? null,
}))

export const COMPETITIVE: CompetitiveRow[] = rawData.competitive_analysis.map((c) => ({
  product: c.product.toLowerCase().replace(/\s+/g, "_"),
  display_name: c.product,
  code_quality_score: c.code_quality_score ?? 0,
  efficiency_score: c.efficiency_score ?? 0,
  cost_per_task_usd: c.cost_per_task_usd ?? c.cost_per_task ?? 0,
  context_window_tokens: c.context_window_tokens ?? 0,
  agent_autonomy_score: c.agent_autonomy_score ?? 0,
  uptime_sla: c.uptime_sla ?? null,
  strengths: c.strengths ?? [],
  weaknesses: c.weaknesses ?? [],
}))

// ---------- Derived analytics --------------------------------------------

export interface TierBreakdown {
  tier: Tier
  category_count: number
  total_share_pct: number
  total_users_affected_pct: number
  categories: Category[]
}

export function tierBreakdown(): TierBreakdown[] {
  const buckets = new Map<Tier, Category[]>([
    [1, []],
    [2, []],
    [3, []],
  ])
  for (const c of CATEGORIES) buckets.get(c.tier)!.push(c)
  return Array.from(buckets.entries()).map(([tier, cats]) => ({
    tier,
    category_count: cats.length,
    total_share_pct: round1(cats.reduce((s, c) => s + c.share_pct, 0)),
    total_users_affected_pct: round1(
      cats.reduce((s, c) => s + c.users_affected_pct, 0),
    ),
    categories: cats,
  }))
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

export function painPoints(limit = 5): PainPoint[] {
  const tierWeight: Record<Tier, number> = { 1: 3, 2: 1.5, 3: 1 }
  const ranked = CATEGORIES.map((c) => {
    const series = categoryTimeseries(c.slug) ?? []
    const critical = series.reduce((s, p) => s + p.severity_critical, 0)
    const high = series.reduce((s, p) => s + p.severity_high, 0)
    const totalIssues = series.reduce((s, p) => s + p.issue_count, 0)
    const avgSent =
      series.length > 0
        ? round2(series.reduce((s, p) => s + p.sentiment, 0) / series.length)
        : 0
    const pain = round2(
      c.users_affected_pct * tierWeight[c.tier] + critical * 3 + high * 1.5,
    )
    return {
      category: c,
      issue_count: totalIssues,
      avg_sentiment: avgSent,
      critical_count: critical,
      high_count: high,
      pain_score: pain,
    }
  })
    .sort((a, b) => b.pain_score - a.pain_score)
    .slice(0, limit)
  return ranked.map((r, idx) => ({ ...r, rank: idx + 1 }))
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

export function sentimentAnalytics(): SentimentAnalytics {
  // Aggregate sentiments across every category×month data point.
  const points: number[] = []
  for (const c of CATEGORIES) {
    const series = categoryTimeseries(c.slug) ?? []
    for (const p of series) points.push(p.sentiment)
  }

  const bucketize = (s: number): string => {
    if (s <= 30) return "very_negative"
    if (s <= 50) return "negative"
    if (s < 65) return "neutral"
    if (s < 80) return "positive"
    return "very_positive"
  }
  const bucketCounts = new Map<string, number>()
  for (const s of points) {
    bucketCounts.set(bucketize(s), (bucketCounts.get(bucketize(s)) ?? 0) + 1)
  }
  const order = ["very_negative", "negative", "neutral", "positive", "very_positive"]
  const distribution = order.map((b) => ({ bucket: b, count: bucketCounts.get(b) ?? 0 }))

  const n = points.length
  const mean = n ? points.reduce((s, v) => s + v, 0) / n : 0
  const variance =
    n > 1 ? points.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0
  return {
    distribution,
    trend: TIMELINE,
    stats: {
      count: n,
      mean: round2(mean),
      stddev: round2(Math.sqrt(variance)),
      min: n ? Math.min(...points) : 0,
      max: n ? Math.max(...points) : 0,
    },
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
