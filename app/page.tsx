"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { RefreshCw, Loader2, BarChart3 } from "lucide-react"
import { StatCard, InsightKpiCard } from "@/components/dashboard/stat-card"
import { HeroInsight, computeHeroInsight } from "@/components/dashboard/hero-insight"
import { 
  LoadingState, 
  EmptyState, 
  ErrorState,
  DashboardSkeleton 
} from "@/components/dashboard/dashboard-states"
import { SentimentChart } from "@/components/dashboard/sentiment-chart"
import { SourceChart } from "@/components/dashboard/source-chart"
import { TrendChart } from "@/components/dashboard/trend-chart"
import { PriorityMatrix } from "@/components/dashboard/priority-matrix"
import { CategoryHeatmap } from "@/components/dashboard/category-heatmap"
import { IssuesTable } from "@/components/dashboard/issues-table"
import { RealtimeInsights } from "@/components/dashboard/realtime-insights"
import { ClassificationTriage } from "@/components/dashboard/classification-triage"
import { GlobalFilterBar } from "@/components/dashboard/global-filter-bar"
import { SeniorReviewCallout } from "@/components/dashboard/senior-review-callout"
import { CompetitiveMentions } from "@/components/dashboard/competitive-mentions"
import {
  useDashboardStats,
  useIssues,
  useScrape,
  useClassifications,
  useClassificationStats,
} from "@/hooks/use-dashboard-data"
import { formatDistanceToNow } from "date-fns"

export default function DashboardPage() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [globalDays, setGlobalDays] = useState(30)
  const [globalCategory, setGlobalCategory] = useState("all")
  const [issueFilters, setIssueFilters] = useState<{
    sentiment?: string
    sortBy?: string
    order?: string
  }>({})

  const { stats, isLoading: statsLoading, isError: statsError, refresh: refreshStats } = useDashboardStats()
  const { issues, isLoading: issuesLoading, refresh: refreshIssues } = useIssues({
    ...issueFilters,
    days: globalDays || undefined,
    category: globalCategory === "all" ? undefined : globalCategory,
  })
  const { scrape } = useScrape()
  const { classifications, isLoading: classificationsLoading, refresh: refreshClassifications } = useClassifications({ limit: 30 })
  const { classificationStats, refresh: refreshClassificationStats } = useClassificationStats()

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await scrape()
      await Promise.all([refreshStats(), refreshIssues(), refreshClassifications(), refreshClassificationStats()])
    } catch (error) {
      console.error("Failed to refresh:", error)
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleFilterChange = (newFilters: typeof issueFilters) => {
    setIssueFilters((prev) => ({ ...prev, ...newFilters }))
  }

  const handleNavigateToCategory = (slug: string) => {
    setGlobalCategory(slug)
    // Scroll to triage section
    document.getElementById("triage-section")?.scrollIntoView({ behavior: "smooth" })
  }

  const categoryOptions = useMemo(() => {
    const dynamic = (stats?.categoryBreakdown || []).map((category) => ({
      value: category.name.toLowerCase().replace(/\s+/g, "-"),
      label: category.name,
      count: category.count,
    }))

    return [{ value: "all", label: "All categories", count: stats?.totalIssues || 0 }, ...dynamic]
  }, [stats])

  const globalTimeLabel = globalDays === 0 ? "All time" : `Last ${globalDays} days`
  const globalCategoryLabel = categoryOptions.find((option) => option.value === globalCategory)?.label || "All categories"

  // Compute KPI summary with insight-first approach
  const kpiSummary = useMemo(() => {
    const grouped = new Map<
      string,
      { 
        total: number
        negative: number
        urgencyProxy: number
        impactTotal: number
        topIssue: { title: string; url: string | null; source: string } | null
      }
    >()

    for (const item of stats?.priorityMatrix || []) {
      const categoryName = item.category?.name || "Uncategorized"
      const sentimentWeight =
        item.sentiment === "negative" ? 1.35 : item.sentiment === "neutral" ? 1 : 0.7
      const urgencyScore = item.impact_score * item.frequency_count * sentimentWeight

      const current = grouped.get(categoryName) || {
        total: 0,
        negative: 0,
        urgencyProxy: 0,
        impactTotal: 0,
        topIssue: null,
      }

      current.total += 1
      if (item.sentiment === "negative") current.negative += 1
      current.urgencyProxy += urgencyScore
      current.impactTotal += item.impact_score
      
      // Track top issue by impact
      if (!current.topIssue || item.impact_score > (current.topIssue as { title: string; url: string | null; source: string; impact?: number }).impact!) {
        current.topIssue = { 
          title: item.title, 
          url: null, // Priority matrix doesn't include URL
          source: "Priority Matrix"
        }
      }
      
      grouped.set(categoryName, current)
    }

    const categories = Array.from(grouped.entries()).map(([name, values]) => ({
      name,
      ...values,
      avgImpact: values.total > 0 ? values.impactTotal / values.total : 0,
      negativeShare: values.total > 0 ? values.negative / values.total : 0,
    }))

    // Filter out "Other" for primary display
    const specificCategories = categories.filter(c => c.name.toLowerCase() !== "other")
    const displayCategories = specificCategories.length > 0 ? specificCategories : categories

    const topRiskCategory = displayCategories.reduce<(typeof categories)[number] | null>(
      (best, candidate) =>
        !best || candidate.urgencyProxy > best.urgencyProxy ? candidate : best,
      null
    )

    const minVolumeForTheme = Math.max(2, Math.ceil((stats?.totalIssues || 0) * 0.05))
    const impactfulPool = displayCategories.filter((category) => category.total >= minVolumeForTheme)
    const mostImpactfulTheme = (impactfulPool.length ? impactfulPool : displayCategories).reduce<
      (typeof categories)[number] | null
    >((best, candidate) => (!best || candidate.avgImpact > best.avgImpact ? candidate : best), null)

    // Find other category stats for display
    const otherCategory = categories.find(c => c.name.toLowerCase() === "other")
    const otherRate = otherCategory && stats?.totalIssues 
      ? (otherCategory.total / stats.totalIssues) * 100 
      : 0

    return {
      topRiskCategory,
      mostImpactfulTheme,
      topRiskNegativeShare: topRiskCategory?.negativeShare || 0,
      otherRate,
      totalSignals: stats?.totalIssues || 0,
    }
  }, [stats])

  // Compute hero insight from realtime data
  const heroInsight = useMemo(() => {
    return computeHeroInsight(stats?.realtimeInsights || [])
  }, [stats?.realtimeInsights])

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
          <DashboardSkeleton />
        ) : statsError ? (
          <ErrorState
            title="Failed to load dashboard"
            message="We couldn't connect to the database. Please check your configuration and try again."
            onRetry={() => refreshStats()}
            showSettings
          />
        ) : !stats || stats.totalIssues === 0 ? (
          <EmptyState
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing}
          />
        ) : (
          <div className="flex flex-col gap-8">
            {/* Hero Insight Block - The "Aha" moment */}
            <HeroInsight 
              topInsight={heroInsight}
              onNavigateToCategory={handleNavigateToCategory}
            />

            {/* Secondary KPI Cards - Insight-first design */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {kpiSummary.topRiskCategory && (
                <InsightKpiCard
                  category={kpiSummary.topRiskCategory.name}
                  headline={`${kpiSummary.topRiskCategory.name} has the highest urgency score combining volume, sentiment, and impact.`}
                  metrics={{
                    total: kpiSummary.topRiskCategory.total,
                    negativeShare: kpiSummary.topRiskCategory.negativeShare,
                    avgImpact: kpiSummary.topRiskCategory.avgImpact,
                  }}
                  topIssue={kpiSummary.topRiskCategory.topIssue || undefined}
                  variant="risk"
                />
              )}
              
              {kpiSummary.mostImpactfulTheme && kpiSummary.mostImpactfulTheme.name !== kpiSummary.topRiskCategory?.name && (
                <InsightKpiCard
                  category={kpiSummary.mostImpactfulTheme.name}
                  headline={`Highest average impact score among categories with sustained volume.`}
                  metrics={{
                    total: kpiSummary.mostImpactfulTheme.total,
                    negativeShare: kpiSummary.mostImpactfulTheme.negativeShare,
                    avgImpact: kpiSummary.mostImpactfulTheme.avgImpact,
                  }}
                  topIssue={kpiSummary.mostImpactfulTheme.topIssue || undefined}
                  variant="impact"
                />
              )}

              {/* Orientation metric - kept minimal */}
              <StatCard
                title="Total Signals"
                value={kpiSummary.totalSignals}
                subtitle="Baseline volume across all sources"
                contextText={kpiSummary.otherRate > 10 
                  ? `${kpiSummary.otherRate.toFixed(0)}% uncategorized - consider taxonomy review`
                  : "Use trends and categories for prioritization, not raw counts."
                }
                icon={<BarChart3 className="h-5 w-5" />}
                variant={kpiSummary.otherRate > 15 ? "warning" : "default"}
              />
            </div>

            {/* Global Filters */}
            <GlobalFilterBar
              timeDays={globalDays}
              onTimeChange={setGlobalDays}
              categoryOptions={categoryOptions}
              categoryValue={globalCategory}
              onCategoryChange={setGlobalCategory}
            />

            {/* Senior Review Callout */}
            <SeniorReviewCallout />

            {/* Charts Row - Visual context */}
            <div className="grid gap-6 lg:grid-cols-3">
              <SentimentChart data={stats.sentimentBreakdown} />
              <SourceChart data={stats.sourceBreakdown} />
              <CategoryHeatmap data={stats.categorySentimentBreakdown} />
            </div>

            {/* Priority Matrix - Actionable view */}
            <PriorityMatrix data={stats.priorityMatrix} />

            {/* Real-time insights + competitive mentions */}
            <div className="grid gap-6 lg:grid-cols-2">
              <RealtimeInsights insights={stats.realtimeInsights} />
              <CompetitiveMentions
                mentions={stats.competitiveMentions || []}
                meta={stats.competitiveMentionsMeta}
              />
            </div>

            {/* Classification Triage - Workflow zone */}
            <div id="triage-section">
              <ClassificationTriage
                records={classifications}
                stats={classificationStats}
                isLoading={classificationsLoading}
                activeCategory={globalCategory}
                timeDays={globalDays}
                onRefresh={async () => {
                  await Promise.all([refreshClassifications(), refreshClassificationStats()])
                }}
              />
            </div>

            {/* Trend Chart - Historical context */}
            {stats.trendData.length > 0 && (
              <TrendChart data={stats.trendData} />
            )}

            {/* Issues Table - Deep dive zone */}
            <IssuesTable
              issues={issues}
              isLoading={issuesLoading}
              globalTimeLabel={globalTimeLabel}
              globalCategoryLabel={globalCategoryLabel}
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
