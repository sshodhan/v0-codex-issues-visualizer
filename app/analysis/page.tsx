"use client"

import Link from "next/link"
import useSWR from "swr"
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Flame,
  LineChart as LineChartIcon,
  ListChecks,
  Target,
  TrendingUp,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  analysisApi,
  type Category,
  type PainPoint,
  type SentimentAnalytics,
  type TierBreakdown,
  type TimelineResponse,
  type UserSegment,
} from "@/lib/analysis-api"

const TIER_META: Record<1 | 2 | 3, { label: string; description: string; tone: string }> = {
  1: {
    label: "TIER 1 — Critical / Cascading",
    description: "Fix these first. Each TIER 1 fix resolves 2+ downstream issues.",
    tone: "border-l-destructive",
  },
  2: {
    label: "TIER 2 — Persistent Quality",
    description: "Long-running quality issues; pre-date the acute crisis.",
    tone: "border-l-amber-500",
  },
  3: {
    label: "TIER 3 — Symptomatic / Operational",
    description: "Lower user impact, but operational friction drives churn.",
    tone: "border-l-blue-500",
  },
}

function severityTone(tier: 1 | 2 | 3): "destructive" | "secondary" | "outline" {
  return tier === 1 ? "destructive" : tier === 2 ? "secondary" : "outline"
}

export default function MarketAnalysisPage() {
  const timeline = useSWR<TimelineResponse>("analysis/timeline", analysisApi.timeline)
  const segments = useSWR<UserSegment[]>("analysis/segments", analysisApi.segments)
  const tiers = useSWR<TierBreakdown[]>("analysis/tiers", analysisApi.tiers)
  const painPoints = useSWR<PainPoint[]>("analysis/pain-points", () =>
    analysisApi.painPoints(7),
  )
  const sentiment = useSWR<SentimentAnalytics>(
    "analysis/sentiment",
    analysisApi.sentiment,
  )

  const loading =
    timeline.isLoading ||
    segments.isLoading ||
    tiers.isLoading ||
    painPoints.isLoading ||
    sentiment.isLoading
  const error =
    timeline.error || segments.error || tiers.error || painPoints.error || sentiment.error

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary p-2">
              <LineChartIcon className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Codex Market Analysis</h1>
              <p className="text-xs text-muted-foreground">
                Trend · Classification · Sentiment · Top Pain Points
              </p>
            </div>
          </div>
          <Button asChild variant="outline" className="gap-2">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              Scraper dashboard
            </Link>
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {error ? (
          <Card className="mb-6 border-destructive/50">
            <CardContent className="flex items-start gap-3 p-6">
              <AlertCircle className="h-5 w-5 flex-none text-destructive" />
              <div>
                <p className="font-semibold">Cannot reach the analysis API</p>
                <p className="text-sm text-muted-foreground">
                  Start the backend with{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    cd backend && uvicorn app.main:app --reload
                  </code>
                  .
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {loading ? <p className="text-muted-foreground">Loading market analysis…</p> : null}

        {/* -------- 1. ISSUE TREND -------- */}
        {timeline.data ? (
          <section className="mb-10">
            <div className="mb-3 flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Issue trend (Jan 2025 → Apr 2026)</h2>
            </div>
            <Card>
              <CardContent className="p-4">
                <div className="mb-4 grid gap-4 md:grid-cols-3">
                  <Stat
                    label="Months tracked"
                    value={String(timeline.data.points.length)}
                    sub={`${timeline.data.points[0].month.slice(0, 7)} → ${timeline.data.points.at(-1)?.month.slice(0, 7)}`}
                  />
                  <Stat
                    label="Crisis trough"
                    value={String(timeline.data.peak_crisis.sentiment)}
                    sub={`${timeline.data.peak_crisis.month.slice(0, 7)} · ${timeline.data.peak_crisis.note ?? ""}`}
                    tone="destructive"
                  />
                  <Stat
                    label="Recovery peak"
                    value={String(timeline.data.peak_recovery.sentiment)}
                    sub={`${timeline.data.peak_recovery.month.slice(0, 7)} · ${timeline.data.peak_recovery.note ?? ""}`}
                    tone="success"
                  />
                </div>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={timeline.data.points.map((p) => ({
                        ...p,
                        monthLabel: p.month.slice(0, 7),
                      }))}
                      margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="monthLabel" fontSize={11} />
                      <YAxis
                        yAxisId="sentiment"
                        domain={[0, 100]}
                        fontSize={11}
                        label={{ value: "Sentiment", angle: -90, position: "insideLeft", fontSize: 11 }}
                      />
                      <YAxis
                        yAxisId="freq"
                        orientation="right"
                        fontSize={11}
                        label={{ value: "Issues/mo", angle: 90, position: "insideRight", fontSize: 11 }}
                      />
                      <Tooltip />
                      <Legend />
                      <Area
                        yAxisId="freq"
                        type="monotone"
                        dataKey="issue_freq"
                        name="Issues/month"
                        fill="hsl(var(--chart-4) / 0.3)"
                        stroke="hsl(var(--chart-4))"
                      />
                      <Line
                        yAxisId="sentiment"
                        type="monotone"
                        dataKey="sentiment"
                        name="Sentiment"
                        stroke="hsl(var(--chart-1))"
                        strokeWidth={2}
                        dot={{ r: 3 }}
                      />
                      <ReferenceLine
                        yAxisId="sentiment"
                        x={timeline.data.peak_crisis.month.slice(0, 7)}
                        stroke="hsl(var(--destructive))"
                        strokeDasharray="4 2"
                        label={{ value: "Peak crisis", position: "top", fontSize: 10 }}
                      />
                      <ReferenceLine
                        yAxisId="sentiment"
                        x={timeline.data.peak_recovery.month.slice(0, 7)}
                        stroke="hsl(142 70% 45%)"
                        strokeDasharray="4 2"
                        label={{ value: "Recovered", position: "top", fontSize: 10 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </section>
        ) : null}

        {/* -------- 2. CLASSIFICATION (TIER 1/2/3) -------- */}
        {tiers.data ? (
          <section className="mb-10">
            <div className="mb-3 flex items-center gap-2">
              <ListChecks className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Classification</h2>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              {tiers.data.map((t) => {
                const meta = TIER_META[t.tier]
                return (
                  <Card key={t.tier} className={`border-l-4 ${meta.tone}`}>
                    <CardHeader>
                      <CardTitle className="text-base">{meta.label}</CardTitle>
                      <CardDescription>{meta.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Categories</span>
                        <span className="font-semibold">{t.category_count}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Share of issues</span>
                        <span className="font-semibold">{t.total_share_pct}%</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Users affected</span>
                        <span className="font-semibold">{t.total_users_affected_pct}%</span>
                      </div>
                      <div className="pt-2">
                        {t.categories.map((c: Category) => (
                          <CategoryRow key={c.id} category={c} />
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </section>
        ) : null}

        {/* -------- 3. USER SENTIMENT -------- */}
        {sentiment.data ? (
          <section className="mb-10">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">User sentiment</h2>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">Distribution across tracked issues</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {sentiment.data.distribution.map((b) => {
                      const max = Math.max(
                        ...sentiment.data!.distribution.map((x) => x.count),
                        1,
                      )
                      const width = Math.round((b.count / max) * 100)
                      return (
                        <div key={b.bucket} className="flex items-center gap-3 text-sm">
                          <span className="w-28 shrink-0 capitalize text-muted-foreground">
                            {b.bucket.replace("_", " ")}
                          </span>
                          <div className="relative h-5 flex-1 rounded bg-muted">
                            <div
                              className="h-full rounded bg-primary"
                              style={{ width: `${width}%` }}
                            />
                          </div>
                          <span className="w-8 shrink-0 text-right font-semibold tabular-nums">
                            {b.count}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Stats</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <Row label="Samples" value={sentiment.data.stats.count} />
                  <Row label="Mean" value={sentiment.data.stats.mean} />
                  <Row label="Std dev" value={sentiment.data.stats.stddev} />
                  <Row label="Min" value={sentiment.data.stats.min} />
                  <Row label="Max" value={sentiment.data.stats.max} />
                </CardContent>
              </Card>
            </div>
            {segments.data ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-5">
                {segments.data.map((s) => (
                  <Card key={s.id}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{s.name}</CardTitle>
                      <CardDescription className="text-xs">
                        {s.developer_count_range}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-1 text-xs">
                      <Row label="Crisis severity" value={`${s.crisis_severity_percentage}%`} />
                      <Row label="Cost impact" value={`${s.cost_impact_percentage}%`} />
                      <Row label="Recovery speed" value={`${s.recovery_speed_percentage}%`} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* -------- 4. TOP PAIN POINTS -------- */}
        {painPoints.data ? (
          <section className="mb-10">
            <div className="mb-3 flex items-center gap-2">
              <Flame className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Top pain points</h2>
              <Badge variant="outline" className="ml-2 gap-1">
                <Target className="h-3 w-3" />
                Codex team action list
              </Badge>
            </div>
            <div className="space-y-2">
              {painPoints.data.map((p) => (
                <Card key={p.category.id}>
                  <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold tabular-nums">
                        #{p.rank}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{p.category.name}</p>
                          <Badge variant={severityTone(p.category.tier)}>
                            TIER {p.category.tier}
                          </Badge>
                          <Badge variant="outline">
                            {p.category.users_affected_pct}% users
                          </Badge>
                        </div>
                        {p.category.action ? (
                          <p className="mt-1 text-sm text-muted-foreground">
                            {p.category.action}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-3 text-xs md:flex md:flex-none md:gap-6">
                      <Metric label="Pain score" value={p.pain_score.toFixed(1)} />
                      <Metric label="Issues" value={String(p.issue_count)} />
                      <Metric label="Critical" value={String(p.critical_count)} />
                      <Metric
                        label="Avg sentiment"
                        value={p.avg_sentiment.toFixed(2)}
                      />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        <p className="mt-10 text-xs text-muted-foreground">
          Data source of truth:{" "}
          <code className="rounded bg-muted px-1 py-0.5">
            backend/app/seed_data.py
          </code>
          . Swap to live Supabase by setting{" "}
          <code className="rounded bg-muted px-1 py-0.5">DATABASE_URL</code>.
        </p>
      </main>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: "destructive" | "success"
}) {
  const border =
    tone === "destructive"
      ? "border-l-destructive"
      : tone === "success"
      ? "border-l-emerald-500"
      : "border-l-border"
  return (
    <Card className={`border-l-4 ${border}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">{value}</div>
        {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  )
}

function CategoryRow({ category }: { category: Category }) {
  return (
    <div className="flex items-center justify-between border-t border-border py-1.5 text-sm first:border-t-0">
      <span className="truncate" style={{ color: category.color }}>
        {category.name}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {category.share_pct}% · {category.users_affected_pct}% users
      </span>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  )
}
