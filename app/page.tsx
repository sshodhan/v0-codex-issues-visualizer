"use client"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { RefreshCw, AlertCircle, Loader2, BarChart3, LineChart } from "lucide-react"
import { StatCard } from "@/components/dashboard/stat-card"
import { SentimentChart } from "@/components/dashboard/sentiment-chart"
import { SourceChart } from "@/components/dashboard/source-chart"
import { TrendChart } from "@/components/dashboard/trend-chart"
import { PriorityMatrix } from "@/components/dashboard/priority-matrix"
import { CategoryHeatmap } from "@/components/dashboard/category-heatmap"
import { IssuesTable } from "@/components/dashboard/issues-table"
import {
  useDashboardStats,
  useIssues,
  useScrape,
} from "@/hooks/use-dashboard-data"
import { formatDistanceToNow } from "date-fns"

export default function DashboardPage() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [filters, setFilters] = useState<{
    sentiment?: string
    category?: string
    days?: number
    sortBy?: string
    order?: string
  }>({})

  const { stats, isLoading: statsLoading, refresh: refreshStats } = useDashboardStats()
  const { issues, isLoading: issuesLoading, refresh: refreshIssues } = useIssues(filters)
  const { scrape } = useScrape()

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await scrape()
      await Promise.all([refreshStats(), refreshIssues()])
    } catch (error) {
      console.error("Failed to refresh:", error)
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleFilterChange = (newFilters: typeof filters) => {
    setFilters((prev) => ({ ...prev, ...newFilters }))
  }

  const lastScrapeTime = stats?.lastScrape?.completed_at
    ? formatDistanceToNow(new Date(stats.lastScrape.completed_at), {
        addSuffix: true,
      })
    : "Never"

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary p-2">
              <BarChart3 className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">
                Codex Issues Visualizer
              </h1>
              <p className="text-xs text-muted-foreground">
                Track and prioritize OpenAI Codex feedback
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Button asChild variant="outline" className="gap-2">
              <Link href="/analysis">
                <LineChart className="h-4 w-4" />
                Market Analysis
              </Link>
            </Button>
            <div className="text-right text-sm">
              <p className="text-muted-foreground">Last synced</p>
              <p className="font-medium text-foreground">{lastScrapeTime}</p>
            </div>
            <Button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="gap-2"
            >
              {isRefreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {isRefreshing ? "Scraping..." : "Refresh Data"}
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {statsLoading ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="text-muted-foreground">Loading dashboard...</p>
            </div>
          </div>
        ) : !stats || stats.totalIssues === 0 ? (
          <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
            <AlertCircle className="h-12 w-12 text-muted-foreground" />
            <div className="text-center">
              <h2 className="text-xl font-semibold text-foreground">
                No Data Yet
              </h2>
              <p className="text-muted-foreground mt-1">
                Click &quot;Refresh Data&quot; to scrape issues from Reddit, Hacker
                News, and GitHub.
              </p>
            </div>
            <Button onClick={handleRefresh} disabled={isRefreshing} size="lg">
              {isRefreshing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Scraping...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Start Scraping
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {/* Stats Cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                title="Total Issues"
                value={stats.totalIssues}
                subtitle="Across all sources"
                icon={<BarChart3 className="h-5 w-5" />}
              />
              <StatCard
                title="Negative Issues"
                value={stats.sentimentBreakdown.negative}
                subtitle="Requires attention"
                className="border-l-4 border-l-[hsl(var(--chart-4))]"
              />
              <StatCard
                title="Feature Requests"
                value={
                  stats.categoryBreakdown.find(
                    (c) => c.name === "Feature Request"
                  )?.count || 0
                }
                subtitle="User suggestions"
                className="border-l-4 border-l-[hsl(var(--chart-5))]"
              />
              <StatCard
                title="Bug Reports"
                value={
                  stats.categoryBreakdown.find((c) => c.name === "Bug")
                    ?.count || 0
                }
                subtitle="Issues to fix"
                className="border-l-4 border-l-[hsl(var(--chart-3))]"
              />
            </div>

            {/* Charts Row 1 */}
            <div className="grid gap-6 lg:grid-cols-3">
              <SentimentChart data={stats.sentimentBreakdown} />
              <SourceChart data={stats.sourceBreakdown} />
              <CategoryHeatmap data={stats.categoryBreakdown} />
            </div>

            {/* Priority Matrix */}
            <PriorityMatrix data={stats.priorityMatrix} />

            {/* Trend Chart */}
            {stats.trendData.length > 0 && (
              <TrendChart data={stats.trendData} />
            )}

            {/* Issues Table */}
            <IssuesTable
              issues={issues}
              isLoading={issuesLoading}
              categories={stats.categoryBreakdown.map(c => ({
                name: c.name,
                slug: c.name.toLowerCase().replace(/\s+/g, '-'),
                color: c.color,
              }))}
              onFilterChange={handleFilterChange}
            />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-6">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>
            Codex Issues Visualizer - Aggregating feedback from Reddit, Hacker
            News, GitHub, and more
          </p>
        </div>
      </footer>
    </div>
  )
}
