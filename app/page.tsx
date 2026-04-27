"use client"

import { Suspense, useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { AsOfBanner } from "@/components/dashboard/as-of-banner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RefreshCw, Loader2, BarChart3, BrainCircuit, BookOpen, TrendingUp, Settings } from "lucide-react"
import { StatCard, InsightKpiCard } from "@/components/dashboard/stat-card"
import { HeroInsight, computeHeroInsight } from "@/components/dashboard/hero-insight"
import { 
  EmptyState, 
  ErrorState,
  DashboardSkeleton,
} from "@/components/dashboard/dashboard-states"
import { SentimentChart } from "@/components/dashboard/sentiment-chart"
import { SourceChart } from "@/components/dashboard/source-chart"
import { TrendChart } from "@/components/dashboard/trend-chart"
import { PriorityMatrix } from "@/components/dashboard/priority-matrix"
import { FingerprintSurgeCard } from "@/components/dashboard/fingerprint-surge-card"

import { IssuesTable } from "@/components/dashboard/issues-table"
import { CategoryIssuesGrid } from "@/components/dashboard/category-issues-grid"
import { ClassificationTriage } from "@/components/dashboard/classification-triage"
import { GlobalFilterBar } from "@/components/dashboard/global-filter-bar"
import { CompetitiveMentions } from "@/components/dashboard/competitive-mentions"
import { DataProvenanceStrip } from "@/components/dashboard/data-provenance-strip"
import { PipelineFreshnessStrip } from "@/components/dashboard/pipeline-freshness-strip"
import { DashboardStoryView } from "@/components/dashboard/dashboard-story-view"
import { V3View } from "@/components/dashboard/v3-view"
import { QuickStatsBar } from "@/components/dashboard/quick-stats-bar"

import { ClusterTrustRibbon } from "@/components/dashboard/cluster-trust-ribbon"
import { TopFamiliesSection } from "@/components/dashboard/family-card"
import { UxVersionToggle, isUxV2 } from "@/components/dashboard/ux-version-toggle"
import { DashboardUxProvider, useDashboardUxVersion } from "@/lib/context/dashboard-ux-context"
import {
  useDashboardStats,
  useIssues,
  useScrape,
  useClassifications,
  useClassificationStats,
  useFingerprintSurges,
  useClusterRollup,
} from "@/hooks/use-dashboard-data"
import { MIN_DISPLAYABLE_LABEL_CONFIDENCE } from "@/lib/storage/cluster-label-fallback"
import { formatDistanceToNow } from "date-fns"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

// Inner component that uses useSearchParams (requires Suspense boundary)
function DashboardContentInner() {
    const { version: uxVersion } = useDashboardUxVersion()
    // V2 is now the default - all Dashboard components render V2 variants.
    // Keeping isV2 for potential future A/B testing or rollback.
    const isV2 = isUxV2(uxVersion) // eslint-disable-line @typescript-eslint/no-unused-vars
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const asOfRaw = searchParams.get("as_of")

  // Validate and parse as_of parameter
  const asOf = useMemo(() => {
    if (!asOfRaw) return null
    const parsed = new Date(asOfRaw)
    if (Number.isNaN(parsed.getTime())) {
      console.warn("[v0] Invalid as_of parameter:", asOfRaw)
      return null
    }
    if (parsed.getTime() > Date.now() + 60_000) {
      console.warn("[v0] as_of cannot be in the future")
      return null
    }
    return asOfRaw
  }, [asOfRaw])

  // Default tab based on UX version: V2 → "dashboard" tab, V3 → "v3" tab
  const [activeTab, setActiveTab] = useState(uxVersion === "v3" ? "v3" : "dashboard")
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [globalDays, setGlobalDays] = useState(30)
  const [globalCategory, setGlobalCategory] = useState("all")
  const [issueFilters, setIssueFilters] = useState<{
    sentiment?: string
    sortBy?: string
    order?: string
  }>({})

  /** Layer-A cluster UUID from `?cluster=` — synced with issues API `cluster_id` and triage filter. */
  const clusterIdFromUrl = useMemo(() => {
    const raw = searchParams.get("cluster")?.trim() ?? null
    return raw && isUuid(raw) ? raw : null
  }, [searchParams])

  /** Regex fingerprint / compound_key drill-down from `?fingerprint=`. */
  const compoundKeyFromUrl = useMemo(() => {
    const raw = searchParams.get("fingerprint")?.trim()
    if (!raw) return undefined as string | undefined
    return raw.length > 0 && raw.length < 4000 ? raw : undefined
  }, [searchParams])

  const llmCategoryFromUrl = useMemo(() => {
    const key = "llm_category"
    if (!searchParams.has(key)) return undefined
    const raw = searchParams.get(key)?.trim() ?? ""
    if (raw === "" || raw === "all") return "all" as const
    return raw.toLowerCase()
  }, [searchParams])

  const triageGroupFromUrl = useMemo(() => {
    const key = "triage_group"
    if (!searchParams.has(key)) return undefined
    const raw = searchParams.get(key)?.trim() ?? ""
    if (raw === "" || raw === "all") return "all" as const
    return raw
  }, [searchParams])

  const applyIssueSearchParams = useCallback(
    (patch: { clusterId?: string | null; compoundKey?: string | null; llmCategory?: string | null }) => {
      const next = new URLSearchParams(searchParams.toString())
      if ("clusterId" in patch) {
        if (patch.clusterId) next.set("cluster", patch.clusterId)
        else next.delete("cluster")
      }
      if ("compoundKey" in patch) {
        if (patch.compoundKey) next.set("fingerprint", patch.compoundKey)
        else next.delete("fingerprint")
      }
      if ("llmCategory" in patch) {
        if (patch.llmCategory) next.set("llm_category", patch.llmCategory)
        else next.delete("llm_category")
      }
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const { stats, isLoading: statsLoading, isError: statsError, refresh: refreshStats } = useDashboardStats({
    days: globalDays || undefined,
    category: globalCategory === "all" ? undefined : globalCategory,
    asOf: asOf || undefined,
  })
  const { issues, isLoading: issuesLoading, refresh: refreshIssues } = useIssues({
    sentiment: issueFilters.sentiment,
    sortBy: issueFilters.sortBy,
    order: issueFilters.order,
    compound_key: compoundKeyFromUrl,
    cluster_id: clusterIdFromUrl || undefined,
    llm_category: llmCategoryFromUrl && llmCategoryFromUrl !== "all" ? llmCategoryFromUrl : undefined,
    days: globalDays || undefined,
    category: globalCategory === "all" ? undefined : globalCategory,
    asOf: asOf || undefined,
  })
  const { data: clusterRollup } = useClusterRollup({
    days: globalDays > 0 ? globalDays : undefined,
    category: globalCategory,
  })
  const { scrape } = useScrape()
  const { classifications, isLoading: classificationsLoading, refresh: refreshClassifications } = useClassifications({
    limit: 100,
    asOf: asOf || undefined,
  })
  const {
    classificationStats,
    isLoading: classificationStatsLoading,
    isError: classificationStatsError,
    refresh: refreshClassificationStats,
  } = useClassificationStats({
    asOf: asOf || undefined,
    // Prereq panel counts observations in the same window the dashboard
    // is showing. 0 (= "All time") maps to undefined so the server-side
    // default (no cutoff) applies.
    days: globalDays > 0 ? globalDays : undefined,
  })
  const { data: fingerprintSurges, refresh: refreshFingerprintSurges } = useFingerprintSurges(24)

  const fingerprintWindowLabel = useMemo(() => {
    const d = fingerprintSurges?.window_days
    if (d === undefined) return undefined
    return d === 1 ? "today vs yesterday" : `last ${d} days`
  }, [fingerprintSurges])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await scrape()
      await Promise.all([
        refreshStats(),
        refreshIssues(),
        refreshClassifications(),
        refreshClassificationStats(),
        refreshFingerprintSurges(),
      ])
    } catch (error) {
      console.error("Failed to refresh:", error)
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleFilterChange = (newFilters: {
    sentiment?: string
    sortBy?: string
    order?: string
    /** Use `""` to clear the fingerprint param from the URL. */
    compound_key?: string
    /** Use `null` to clear the cluster param from the URL. */
    cluster_id?: string | null
    /** Use `null` to clear the llm_category param from the URL. */
    llm_category?: string | null
  }) => {
    const { compound_key, cluster_id, llm_category, ...tableOnly } = newFilters
    if (Object.keys(tableOnly).length > 0) {
      setIssueFilters((prev) => ({ ...prev, ...tableOnly }))
    }

    if (compound_key !== undefined || cluster_id !== undefined || llm_category !== undefined) {
      const next = new URLSearchParams(searchParams.toString())
      if (compound_key !== undefined) {
        if (compound_key) {
          next.set("fingerprint", compound_key)
          next.delete("cluster")
        } else {
          next.delete("fingerprint")
        }
      }
      if (cluster_id !== undefined) {
        if (cluster_id) {
          next.set("cluster", cluster_id)
          next.delete("fingerprint")
        } else {
          next.delete("cluster")
        }
      }
      if (llm_category !== undefined) {
        if (llm_category) {
          next.set("llm_category", llm_category)
        } else {
          next.delete("llm_category")
        }
      }
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    }

    const shouldScrollToTable =
      (compound_key !== undefined && compound_key.length > 0) ||
      (cluster_id !== undefined && cluster_id !== null)
    if (shouldScrollToTable && typeof window !== "undefined") {
      requestAnimationFrame(() => {
        document.getElementById("issues-table-anchor")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        })
      })
    }
  }

  const handleNavigateToCategory = (slug: string) => {
    // Stay on Dashboard tab and scroll to issues table with category filter
    setGlobalCategory(slug)
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        document.getElementById("dashboard-issues-table-anchor")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        })
      })
    }
  }

  const handleHeroExploreIssues = (categorySlug: string) => {
    setActiveTab("v3")
    setGlobalCategory(categorySlug)
    if (typeof window !== "undefined") {
      // Use setTimeout to allow the tab to render before scrolling
      setTimeout(() => {
        requestAnimationFrame(() => {
          document.getElementById("issues-table-anchor")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          })
        })
      }, 100)
    }
  }

  const scrollToIssuesTable = () => {
    setActiveTab("v3")
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        document.getElementById("issues-table-anchor")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        })
      })
    }
  }

  const handleStoryDrillError = (compoundKey: string) => {
    setActiveTab("v3")
    handleFilterChange({ compound_key: compoundKey })
  }

  const handleStoryOpenClusterInTable = (clusterId: string) => {
    setActiveTab("v3")
    handleFilterChange({ cluster_id: clusterId })
  }

  const handleStoryOpenClusterInTriage = (clusterId: string) => {
    setActiveTab("classifications")
    applyIssueSearchParams({ clusterId })
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        document.getElementById("triage-semantic-clusters")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        })
      })
    }
  }

  const applyTriageContextParams = useCallback(
    (patch: { llm?: string | null; group?: string | null }) => {
      const next = new URLSearchParams(searchParams.toString())
      if ("llm" in patch) {
        if (patch.llm) {
          next.set("llm_category", patch.llm)
        } else {
          next.delete("llm_category")
        }
      }
      if ("group" in patch) {
        if (patch.group) {
          next.set("triage_group", patch.group)
        } else {
          next.delete("triage_group")
        }
      }
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const handleTriageGroupUrl = useCallback(
    (v: string) => {
      applyTriageContextParams({ group: v === "all" ? null : v })
    },
    [applyTriageContextParams],
  )

  const handleStoryHeuristicFromAtlas = (slug: string) => {
    setGlobalCategory(slug)
    applyTriageContextParams({ llm: null, group: null })
  }

  const handleStoryLlmTriage = (llmCategorySlug: string) => {
    setActiveTab("classifications")
    applyTriageContextParams({
      llm: llmCategorySlug === "all" ? null : llmCategorySlug,
      group: null,
    })
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        const el =
          document.getElementById("triage-llm-link-scope") || document.getElementById("triage-top-groups")
        el?.scrollIntoView({ behavior: "smooth", block: "start" })
      })
    }
  }

const handleHeroLlmCategoryDrill = (
  categorySlug: string,
  llmCategorySlug: string,
  ) => {
  // Stay on Dashboard tab and scroll to issues table with LLM category filter
  setGlobalCategory(categorySlug)
  applyIssueSearchParams({ llmCategory: llmCategorySlug })
  if (typeof window !== "undefined") {
  requestAnimationFrame(() => {
  const el = document.getElementById("dashboard-issues-table-anchor")
  el?.scrollIntoView({ behavior: "smooth", block: "start" })
  })
  }
  }

  const handleOpenDashboardFromStoryAtlas = () => {
    setActiveTab("v3")
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }))
    }
  }

  const handleTriageSemanticClusterUrl = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams.toString())
      if (id === "all") {
        next.delete("cluster")
      } else {
        next.set("cluster", id)
        next.delete("fingerprint")
      }
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const activeClusterLabel = useMemo(() => {
    if (!clusterIdFromUrl) return null
    const row = (clusterRollup?.clusters || []).find((c) => c.id === clusterIdFromUrl)
    // Display copy: clusters are surfaced to users as "Families"; the
    // labeller pipeline (LLM with a deterministic Topic+error fallback —
    // lib/storage/cluster-label-fallback.ts) writes confidence ≥
    // MIN_DISPLAYABLE_LABEL_CONFIDENCE for every cluster, so the show-
    // threshold matches that constant. The `Cluster #…` literal is
    // defence-in-depth for the rare label-IS-NULL case.
    // See docs/ARCHITECTURE.md §6.0.
    if (!row) return `Cluster #${clusterIdFromUrl.slice(0, 8)}`
    if (
      row.label &&
      row.label_confidence != null &&
      row.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE
    ) {
      return row.label
    }
    return `Cluster #${clusterIdFromUrl.slice(0, 8)}`
  }, [clusterIdFromUrl, clusterRollup])

  const categoryOptions = useMemo(() => {
    const dynamic = (stats?.categoryBreakdown || []).map((category) => ({
      value: category.name.toLowerCase().replace(/\s+/g, "-"),
      label: category.name,
      count: category.count,
    }))

    // UI label "All topics" — the heuristic regex bucket (Bug, Feature
    // Request, Performance, …) is surfaced as "Topic" to disambiguate
    // from the LLM `category` enum. See docs/ARCHITECTURE.md §6.0.
    return [{ value: "all", label: "All topics", count: stats?.totalIssues || 0 }, ...dynamic]
  }, [stats])

  /** Heuristic issue count in scope (matches GlobalFilterBar) — for LLM tab explainer. */
  const heuristicScopeIssueCount = useMemo(() => {
    if (!stats) return 0
    if (globalCategory === "all") return stats.totalIssues
    const found = (stats.categoryBreakdown || []).find(
      (c) => c.name.toLowerCase().replace(/\s+/g, "-") === globalCategory,
    )
    return found?.count ?? 0
  }, [stats, globalCategory])

  const globalTimeLabel = globalDays === 0 ? "All time" : `Last ${globalDays} days`
  const globalCategoryLabel = categoryOptions.find((option) => option.value === globalCategory)?.label || "All topics"

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
          url: null,
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

  const nowNextCrosswalk = useMemo(() => {
    if (!stats || !heroInsight) return null

    const breakingNowRank = Math.max(
      1,
      (stats.realtimeInsights || []).findIndex(
        (row) => row.category.slug === heroInsight.categorySlug,
      ) + 1,
    )

    const categoryRows = new Map<
      string,
      { categoryName: string; totalActionability: number; totalImpact: number; totalFrequency: number; count: number }
    >()
    for (const row of stats.priorityMatrix || []) {
      const categoryName = row.category?.name || "Uncategorized"
      const key = categoryName.toLowerCase().replace(/\s+/g, "-")
      const bucket = categoryRows.get(key) ?? {
        categoryName,
        totalActionability: 0,
        totalImpact: 0,
        totalFrequency: 0,
        count: 0,
      }
      bucket.totalActionability += Number(row.actionability ?? 0)
      bucket.totalImpact += Number(row.impact_score ?? 0)
      bucket.totalFrequency += Number(row.frequency_count ?? 0)
      bucket.count += 1
      categoryRows.set(key, bucket)
    }

    const fixFirstOrder = Array.from(categoryRows.entries())
      .map(([slug, bucket]) => {
        const avgActionability = bucket.count > 0 ? bucket.totalActionability / bucket.count : 0
        const avgImpact = bucket.count > 0 ? bucket.totalImpact / bucket.count : 0
        const normalizedImpact = avgImpact / 10
        const normalizedFrequency = Math.min(bucket.totalFrequency / 10, 1)
        const priorityScore = Math.round((normalizedImpact * 0.65 + normalizedFrequency * 0.35) * 100)
        return {
          slug,
          categoryName: bucket.categoryName,
          actionabilityScore: Math.round(avgActionability * 100),
          priorityScore,
        }
      })
      .sort(
        (a, b) =>
          b.actionabilityScore - a.actionabilityScore || b.priorityScore - a.priorityScore,
      )

    const fixFirstRank = Math.max(
      1,
      fixFirstOrder.findIndex((row) => row.slug === heroInsight.categorySlug) + 1,
    )
    const fixFirstRow = fixFirstOrder.find((row) => row.slug === heroInsight.categorySlug) ?? null

    return {
      category: heroInsight.category,
      breakingNowRank,
      fixFirstRank,
      actionabilityScore: fixFirstRow?.actionabilityScore ?? null,
    }
  }, [heroInsight, stats])

  const lastScrapeTime = stats?.lastScrape?.completed_at
    ? formatDistanceToNow(new Date(stats.lastScrape.completed_at), {
        addSuffix: true,
      })
    : "Never"

  // Classification stats for tab badge
  const pendingReviewCount = classificationStats?.needsReviewCount ??
    classifications.filter(r => r.needs_human_review).length

  // Pipeline freshness strip inputs. The strip distinguishes "no issues yet"
  // from "pipeline not caught up" from "stats feed failed / unknown" — so
  // `undefined` (still loading) and `null` (server returned no prereqs) are
  // kept separate rather than collapsed to a healthy-looking zero. See
  // components/dashboard/pipeline-freshness-strip.tsx.
  const pipelinePrereq = classificationStatsLoading
    ? undefined
    : classificationStats?.prerequisites ?? null
  const pipelineReviewCount = classificationStatsLoading
    ? undefined
    : classificationStats?.needsReviewCount

  return (
    <div className="min-h-screen bg-background">
      {/* As-Of Replay Banner */}
      <AsOfBanner asOf={asOf} />

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
          <div className="flex items-center gap-2 sm:gap-4 flex-wrap justify-end">
            <UxVersionToggle />
            <div className="text-right text-sm">
              <p className="text-muted-foreground">Last synced</p>
              <p className="font-medium text-foreground">{lastScrapeTime}</p>
            </div>
            <Button asChild variant="ghost" size="icon" title="Admin">
              <Link href="/admin" aria-label="Admin">
                <Settings className="h-4 w-4" />
              </Link>
            </Button>
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
      <main className="container mx-auto px-4 py-6 space-y-6">
        {/*
          Persistent pipeline-freshness strip. Rendered ABOVE the
          loading/error/empty branching so "no issues in this window" vs
          "pipeline still catching up" vs "stats feed failed" are visible
          in every state — not hidden behind the dashboard-loaded gate.
        */}
        <PipelineFreshnessStrip
          prereq={pipelinePrereq}
          pendingReviewCount={pipelineReviewCount}
          statsError={Boolean(classificationStatsError)}
          windowLabel={globalTimeLabel}
          asOfActive={asOf != null}
        />

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
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
            <TabsList className="grid w-full max-w-2xl grid-cols-4 mx-auto h-auto p-1 gap-0">
              <TabsTrigger value="dashboard" className="gap-1.5 text-xs sm:text-sm py-2.5">
                <TrendingUp className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                <span className="truncate">Dashboard</span>
              </TabsTrigger>
              <TabsTrigger value="v3" className="gap-1.5 text-xs sm:text-sm py-2.5">
                <BarChart3 className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                <span className="truncate">Triage</span>
              </TabsTrigger>
  <TabsTrigger value="story" className="gap-1.5 text-xs sm:text-sm py-2.5">
  <BookOpen className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
  <span className="truncate">Birds Eye View</span>
  </TabsTrigger>
              <TabsTrigger value="classifications" className="gap-1.5 text-xs sm:text-sm py-2.5 relative">
                <BrainCircuit className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                <span className="truncate sm:hidden">AI</span>
                <span className="hidden sm:inline truncate">Classifications</span>
                {pendingReviewCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground sm:static sm:ml-1 sm:h-5 sm:min-w-5 sm:px-1.5 sm:text-xs">
                    {pendingReviewCount}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {/* Dashboard Tab */}
            <TabsContent value="dashboard" className="space-y-8 mt-6">
              {/* V2: Always show DataProvenanceStrip */}
              <DataProvenanceStrip
                lastSyncLabel={lastScrapeTime}
                issueWindowLabel={globalTimeLabel}
                asOfActive={asOf != null}
              />

              {/* V2: Hero-first narrative, then surges (NYT-style layout) */}
              <HeroInsight
                topInsight={heroInsight}
                onExploreIssues={handleHeroExploreIssues}
                onNavigateToCategory={handleNavigateToCategory}
                onLlmCategoryDrill={handleHeroLlmCategoryDrill}
                issueTableTimeLabel={globalTimeLabel}
                variant="v2"
              />
              <FingerprintSurgeCard
                data={fingerprintSurges}
                windowHours={24}
                windowLabelForCopy={fingerprintWindowLabel}
                onFilter={(compoundKey) => handleFilterChange({ compound_key: compoundKey })}
                variant="v2"
              />
              {nowNextCrosswalk && (
                <Card className="border-primary/20 bg-primary/5">
                  <CardContent className="py-3 px-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary mb-1">
                      Crosswalk · now vs next
                    </p>
                    <p className="text-sm text-foreground">
                      <span className="font-medium">{nowNextCrosswalk.category}</span> is{" "}
                      <span className="font-medium">#{nowNextCrosswalk.breakingNowRank}</span> in
                      Breaking Now (72h) and{" "}
                      <span className="font-medium">#{nowNextCrosswalk.fixFirstRank}</span> in
                      Fix-First Queue
                      {nowNextCrosswalk.actionabilityScore != null
                        ? ` (${nowNextCrosswalk.actionabilityScore}/100 actionability).`
                        : "."}
                    </p>
                  </CardContent>
                </Card>
              )}

              {/*
                [V1 - DEPRECATED] Original layout: fingerprint surges above hero.
                Keeping for reference but not rendered. Remove when V2 is stable.
                
                <FingerprintSurgeCard variant="v1" ... />
                <HeroInsight variant="v1" ... />
              */}

              {/* Global Filters */}
              <GlobalFilterBar
                timeDays={globalDays}
                onTimeChange={setGlobalDays}
                categoryOptions={categoryOptions}
                categoryValue={globalCategory}
                onCategoryChange={setGlobalCategory}
              />

              {/* Charts Row - Visual context */}
              <div className="grid gap-6 lg:grid-cols-2">
                <SentimentChart data={stats.sentimentBreakdown} />
                <SourceChart data={stats.sourceBreakdown} />
              </div>

              {/* Priority Matrix - Actionable view */}
              <div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Breaking Now = urgency trend (last 72h). Fix-First Queue = implementation actionability.
                These can differ and are intended to be read together.
              </div>
              {/* V2: Enhanced PriorityMatrix with additional visual elements */}
              <PriorityMatrix
                data={stats.priorityMatrix}
                onFilterChange={handleFilterChange}
                variant="v2"
              />
              {/* [V1 - DEPRECATED] variant="v1" - simpler matrix without V2 enhancements */}

              {/* V2: Skip hero category since it's already featured above */}
              <CategoryIssuesGrid
                insights={stats.realtimeInsights}
                skipFirstCategorySlug={heroInsight?.categorySlug}
                onViewFullList={handleHeroExploreIssues}
              />
              {/* [V1 - DEPRECATED] skipFirstCategorySlug={undefined} - shows all categories including hero */}

              {/* Trend Chart - Historical context */}
              {stats.trendData.length > 0 && (
                <TrendChart data={stats.trendData} />
              )}

{/* Issues Table - Deep dive zone */}
<div id="dashboard-issues-table-anchor" className="scroll-mt-20">
<IssuesTable
  issues={issues}
  isLoading={issuesLoading}
  globalTimeLabel={globalTimeLabel}
  globalCategoryLabel={globalCategoryLabel}
  observationCount={issues.length}
  canonicalCount={stats?.totalIssues || issues.length}
  onFilterChange={handleFilterChange}
  activeCompoundKey={compoundKeyFromUrl}
  activeClusterId={clusterIdFromUrl ?? undefined}
  activeClusterLabel={activeClusterLabel ?? undefined}
  activeLlmCategory={llmCategoryFromUrl && llmCategoryFromUrl !== "all" ? llmCategoryFromUrl : undefined}
  />
</div>
</TabsContent>

            {/* V3 Tab - Simplified Priority Rails Focus */}
            <TabsContent value="v3" className="space-y-6 mt-6">
              {/* Quick Stats Bar */}
              <QuickStatsBar
                clusters={clusterRollup?.clusters || []}
                pipelineState={clusterRollup?.pipeline_state}
                days={globalDays}
              />

              {/* Days Filter - simplified to just time range */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Time range:</span>
                <div className="flex gap-1">
                  {[7, 14, 30, 0].map((d) => (
                    <Button
                      key={d}
                      size="sm"
                      variant={globalDays === d ? "default" : "outline"}
                      onClick={() => setGlobalDays(d)}
                      className="h-7 px-2.5 text-xs"
                    >
                      {d === 0 ? "All" : `${d}d`}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Top Families - Semantic clusters with LOUDEST/FIX FIRST badges */}
              <TopFamiliesSection
                clusters={clusterRollup?.clusters || []}
                days={globalDays}
              />

              {/* Priority Rails - The core decision-making interface */}
              <V3View 
                clusters={clusterRollup?.clusters || []} 
                days={globalDays} 
                pipelineState={clusterRollup?.pipeline_state} 
              />

              {/* Issues Table - Full filtered list */}
              <div id="issues-table-anchor" className="scroll-mt-20">
                <IssuesTable
                  issues={issues}
                  isLoading={issuesLoading}
                  globalTimeLabel={globalTimeLabel}
                  globalCategoryLabel={globalCategoryLabel}
                  observationCount={issues.length}
                  canonicalCount={stats?.totalIssues || issues.length}
                  onFilterChange={handleFilterChange}
                  activeCompoundKey={compoundKeyFromUrl}
                  activeClusterId={clusterIdFromUrl ?? undefined}
                  activeClusterLabel={activeClusterLabel ?? undefined}
                />
              </div>
            </TabsContent>

            <TabsContent value="story" className="mt-6 min-h-screen">
              <DashboardStoryView
                issues={issues}
                issuesLoading={issuesLoading}
                statsTotalIssues={stats.totalIssues}
                heroCategoryName={heroInsight?.category ?? null}
                heroUrgencyLine={heroInsight?.subheadline ?? null}
                fingerprintSurges={fingerprintSurges}
                windowLabel={fingerprintWindowLabel ?? "recent days"}
                onDrillErrorCode={handleStoryDrillError}
                onOpenIssuesTable={scrollToIssuesTable}
                clusterRows={clusterRollup?.clusters}
                onOpenClusterInTable={handleStoryOpenClusterInTable}
                onOpenClusterInTriage={handleStoryOpenClusterInTriage}
                activeClusterId={clusterIdFromUrl}
                timeDays={globalDays}
                onTimeChange={setGlobalDays}
                categoryOptions={categoryOptions}
                categoryValue={globalCategory}
                onCategoryChange={setGlobalCategory}
                lastSyncLabel={lastScrapeTime}
                globalTimeLabel={globalTimeLabel}
                asOfActive={asOf != null}
                categoryBreakdown={stats.categoryBreakdown}
                llmCategoryBreakdown={stats.llmCategoryBreakdown ?? []}
                llmClassifiedInWindow={stats.llmClassifiedInWindow ?? 0}
                llmPendingInWindow={stats.llmPendingInWindow ?? 0}
                onStoryHeuristicFromAtlas={handleStoryHeuristicFromAtlas}
                onStoryLlmTriage={handleStoryLlmTriage}
                onOpenDashboardFromAtlas={handleOpenDashboardFromStoryAtlas}
                selectedLlmCategorySlug={
                  llmCategoryFromUrl && llmCategoryFromUrl !== "all" ? llmCategoryFromUrl : null
                }
              />
              <div className="mt-6">
                <CompetitiveMentions
                  mentions={stats.competitiveMentions || []}
                  meta={stats.competitiveMentionsMeta}
                />
              </div>
            </TabsContent>

            {/* AI Classifications Tab */}
            <TabsContent value="classifications" className="space-y-6 mt-6">
              <GlobalFilterBar
                timeDays={globalDays}
                onTimeChange={setGlobalDays}
                categoryOptions={categoryOptions}
                categoryValue={globalCategory}
                onCategoryChange={setGlobalCategory}
              />

              <ClassificationTriage
                records={classifications}
                stats={classificationStats}
                isLoading={classificationsLoading}
                activeCategory={globalCategory}
                timeDays={globalDays}
                onRefresh={async () => {
                  await Promise.all([refreshClassifications(), refreshClassificationStats()])
                }}
                uxVariant="v2"
                /* [V1 - DEPRECATED] uxVariant="v1" - older triage layout */
                lastSyncLabel={lastScrapeTime}
                asOfActive={asOf != null}
                heuristicScopeIssueCount={heuristicScopeIssueCount}
                semanticClusterControl={{
                  value: clusterIdFromUrl ? clusterIdFromUrl : "all",
                  onChange: handleTriageSemanticClusterUrl,
                }}
                groupControl={{
                  value:
                    triageGroupFromUrl === undefined
                      ? "all"
                      : triageGroupFromUrl === "all"
                        ? "all"
                        : triageGroupFromUrl,
                  onChange: handleTriageGroupUrl,
                }}
                overrideLlmCategoryFilter={
                  !llmCategoryFromUrl || llmCategoryFromUrl === "all"
                    ? "all"
                    : llmCategoryFromUrl
                }
              />
            </TabsContent>


          </Tabs>
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

function DashboardContent() {
  return (
    <DashboardUxProvider>
      <DashboardContentInner />
    </DashboardUxProvider>
  )
}

// Default export wraps content in Suspense to support useSearchParams during static build
export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  )
}
