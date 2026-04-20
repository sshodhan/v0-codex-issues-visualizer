"use client"

import Link from "next/link"
import useSWR from "swr"
import { ArrowLeft, LineChart, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  analysisApi,
  type CompetitiveRow,
  type RootCause,
  type TimelineResponse,
  type UserSegment,
} from "@/lib/analysis-api"

export default function MarketAnalysisPage() {
  const timeline = useSWR<TimelineResponse>("analysis/timeline", analysisApi.timeline)
  const segments = useSWR<UserSegment[]>("analysis/segments", analysisApi.segments)
  const rootCauses = useSWR<RootCause[]>("analysis/root-causes", analysisApi.rootCauses)
  const competitive = useSWR<CompetitiveRow[]>(
    "analysis/competitive",
    analysisApi.competitive,
  )

  const loading =
    timeline.isLoading ||
    segments.isLoading ||
    rootCauses.isLoading ||
    competitive.isLoading

  const error =
    timeline.error || segments.error || rootCauses.error || competitive.error

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary p-2">
              <LineChart className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Codex Market Analysis</h1>
              <p className="text-xs text-muted-foreground">
                Pre-computed crisis timeline, root causes, and segment impact
              </p>
            </div>
          </div>
          <Button asChild variant="outline" className="gap-2">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              Back to scraper dashboard
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
                  </code>{" "}
                  and set{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    NEXT_PUBLIC_ANALYSIS_API_URL
                  </code>
                  . Without a DB the API still serves the canonical seed data.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {loading ? (
          <p className="text-muted-foreground">Loading market analysis…</p>
        ) : null}

        {timeline.data ? (
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold">Crisis arc</h2>
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground">
                    Months tracked
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {timeline.data.points.length}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {timeline.data.points[0].month.slice(0, 7)} →{" "}
                    {timeline.data.points.at(-1)?.month.slice(0, 7)}
                  </p>
                </CardContent>
              </Card>
              <Card className="border-l-4 border-l-destructive">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground">
                    Crisis peak
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {timeline.data.peak_crisis.sentiment}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {timeline.data.peak_crisis.month.slice(0, 7)} ·{" "}
                    {timeline.data.peak_crisis.note}
                  </p>
                </CardContent>
              </Card>
              <Card className="border-l-4 border-l-emerald-500">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground">
                    Recovery peak
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {timeline.data.peak_recovery.sentiment}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {timeline.data.peak_recovery.month.slice(0, 7)} ·{" "}
                    {timeline.data.peak_recovery.note}
                  </p>
                </CardContent>
              </Card>
            </div>
          </section>
        ) : null}

        {segments.data ? (
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold">User segment impact</h2>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {segments.data.map((s) => (
                <Card key={s.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between text-base">
                      {s.name}
                      <Badge variant="outline">{s.developer_count_range}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-muted-foreground">{s.description}</p>
                    <div className="flex justify-between">
                      <span>Crisis severity</span>
                      <span className="font-semibold">
                        {s.crisis_severity_percentage}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Cost impact</span>
                      <span className="font-semibold">
                        {s.cost_impact_percentage}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Recovery speed</span>
                      <span className="font-semibold">
                        {s.recovery_speed_percentage}%
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {rootCauses.data ? (
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold">
              Top root causes ({rootCauses.data.length})
            </h2>
            <div className="space-y-2">
              {rootCauses.data.slice(0, 5).map((rc) => (
                <Card key={rc.id}>
                  <CardContent className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{rc.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {rc.component}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-sm">
                      <Badge
                        variant={
                          rc.severity === "critical" ? "destructive" : "secondary"
                        }
                      >
                        {rc.severity}
                      </Badge>
                      <span className="tabular-nums">
                        {rc.estimated_users_impacted_percentage}% users
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {rc.affected_issue_count} issues
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {competitive.data ? (
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold">Competitive positioning</h2>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {competitive.data.map((c) => (
                <Card key={c.id}>
                  <CardHeader>
                    <CardTitle className="text-base">{c.display_name}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span>Code quality</span>
                      <span className="font-semibold">{c.code_quality_score}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Agent autonomy</span>
                      <span className="font-semibold">{c.agent_autonomy_score}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Cost / task</span>
                      <span className="font-semibold">
                        ${c.cost_per_task_usd}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Context window</span>
                      <span className="font-semibold">
                        {(c.context_window_tokens / 1000).toFixed(0)}k
                      </span>
                    </div>
                    <p className="pt-2 text-xs text-muted-foreground">
                      {c.summary}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        <p className="mt-10 text-xs text-muted-foreground">
          Phase 1 preview. Week 2 adds interactive timeline, issue search,
          segment heatmap, and per-root-cause Gantt views.
        </p>
      </main>
    </div>
  )
}
