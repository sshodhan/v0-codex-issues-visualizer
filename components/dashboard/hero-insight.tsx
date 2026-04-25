"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  ExternalLink,
  Sparkles,
} from "lucide-react"
import {
  InterpretationContractDialog,
  UrgencyModelDialog,
  MethodologyTriggerButton,
} from "@/components/dashboard/methodology-dialogs"
import {
  llmCategoryLabel,
  llmCategoryPalette,
} from "@/lib/classification/llm-category-display"

interface HeroInsightProps {
  topInsight: {
    category: string
    categorySlug: string
    headline: string
    subheadline: string
    metrics: {
      total: number
      negativeShare: number
      momentum: number
      sourcesReporting: number
    }
    /** LLM-category breakdown of the issues counted in `metrics.total`, sorted desc. */
    llmCategoryBreakdown: Array<{ slug: string; count: number }>
    /** Count of `metrics.total` rows with no LLM classification yet. */
    llmUnclassifiedCount: number
    topIssues: Array<{
      id: string
      title: string
      url: string | null
      source: string
      impact_score: number
    }>
  } | null
  /** Primary: set category filter, stay on dashboard, scroll to issues table */
  onExploreIssues: (categorySlug: string) => void
  /** Secondary: switch to AI Classifications for triage with category filter */
  onNavigateToCategory?: (slug: string) => void
  /** Click on a pill in the LLM-classification cloud — opens triage scoped to (category × llm_category). */
  onLlmCategoryDrill?: (categorySlug: string, llmCategorySlug: string) => void
  /** Shown on primary CTA (V2) so users know the table may use a different time range than the 72h lead story. */
  issueTableTimeLabel?: string
  /** V1: original single CTA to classifications. V2: NYT-style + dual CTAs + methodology. */
  variant?: "v1" | "v2"
  className?: string
}

export function HeroInsight({
  topInsight,
  onExploreIssues,
  onNavigateToCategory,
  onLlmCategoryDrill,
  issueTableTimeLabel = "",
  variant = "v2",
  className,
}: HeroInsightProps) {
  const [interpretationOpen, setInterpretationOpen] = useState(false)
  const [urgencyOpen, setUrgencyOpen] = useState(false)
  const isV2 = variant === "v2"

  if (!topInsight) {
    return (
      <Card className={cn("bg-card border-border", className)}>
        <CardContent className="p-8 text-center">
          <Sparkles className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">
            No urgent insights detected
          </h2>
          <p className="text-muted-foreground">
            All topics are within normal thresholds. Check back after your next data sync.
          </p>
        </CardContent>
      </Card>
    )
  }

  const {
    category,
    categorySlug,
    headline,
    subheadline,
    metrics,
    topIssues,
    llmCategoryBreakdown,
    llmUnclassifiedCount,
  } = topInsight
  const isRising = metrics.momentum > 0
  const llmClassifiedCount = llmCategoryBreakdown.reduce((sum, row) => sum + row.count, 0)
  const llmTotalCount = llmClassifiedCount + llmUnclassifiedCount
  const llmClassifiedSharePct =
    llmTotalCount > 0 ? Math.round((llmClassifiedCount / llmTotalCount) * 100) : 0
  const maxLlmCount = llmCategoryBreakdown[0]?.count ?? 0

  const cloud = (
    <LlmClassificationCloud
      categoryName={category}
      categorySlug={categorySlug}
      breakdown={llmCategoryBreakdown}
      unclassifiedCount={llmUnclassifiedCount}
      classifiedSharePct={llmClassifiedSharePct}
      maxCount={maxLlmCount}
      onDrill={onLlmCategoryDrill}
    />
  )

  if (!isV2) {
    return (
      <Card
        className={cn(
          "relative overflow-hidden bg-gradient-to-br from-card to-card/80 border-border shadow-lg",
          className
        )}
      >
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[var(--negative)] via-[var(--insight-warning)] to-[var(--negative)]" />
        <CardContent className="p-6 md:p-8">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <Badge
                  variant="outline"
                  className="bg-[var(--negative)]/10 text-[var(--negative)] border-[var(--negative)]/20 font-semibold"
                >
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Needs Attention
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "font-medium",
                    isRising
                      ? "bg-[var(--negative)]/10 text-[var(--negative)] border-[var(--negative)]/20"
                      : "bg-[var(--positive)]/10 text-[var(--positive)] border-[var(--positive)]/20"
                  )}
                >
                  {isRising ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                  {isRising ? "+" : ""}
                  {metrics.momentum}% vs last period
                </Badge>
              </div>
              <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-2 text-balance">{headline}</h2>
              <p className="text-muted-foreground text-lg mb-6">{subheadline}</p>
              <div className="flex flex-wrap gap-6 mb-6">
                <div className="flex flex-col">
                  <span className="text-2xl font-bold text-foreground">{metrics.total}</span>
                  <span className="text-sm text-muted-foreground">total signals</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-2xl font-bold text-[var(--negative)]">
                    {Math.round(metrics.negativeShare * 100)}%
                  </span>
                  <span className="text-sm text-muted-foreground">negative sentiment</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-2xl font-bold text-foreground">{metrics.sourcesReporting}</span>
                  <span className="text-sm text-muted-foreground">sources reporting</span>
                </div>
              </div>
              {cloud}
              <Button
                onClick={() => onNavigateToCategory?.(categorySlug)}
                className="gap-2"
                size="lg"
              >
                Review {category} issues
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
            <div className="lg:w-96 lg:pl-6 lg:border-l lg:border-border">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Representative Issues
              </h3>
              <div className="space-y-3">
                {topIssues.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sample issues available.</p>
                ) : (
                  topIssues.slice(0, 3).map((issue, index) => (
                    <div key={issue.id} className="bg-secondary/50 rounded-lg p-3 hover:bg-secondary transition-colors">
                      <div className="flex items-start gap-2">
                        <span className="text-xs font-bold text-muted-foreground shrink-0">#{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          {issue.url ? (
                            <a
                              href={issue.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm font-medium text-foreground hover:text-primary line-clamp-2 flex items-start gap-1"
                            >
                              <span className="flex-1">{issue.title}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground" />
                            </a>
                          ) : (
                            <p className="text-sm font-medium text-foreground line-clamp-2">{issue.title}</p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-muted-foreground">{issue.source}</span>
                            <span className="text-xs text-muted-foreground">Impact: {issue.impact_score.toFixed(1)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card
        className={cn(
          "relative overflow-hidden bg-gradient-to-br from-card to-card/80 border-border shadow-lg",
          className
        )}
      >
        <div className="absolute top-0 left-0 right-0 h-1 bg-border" />

        <CardContent className="p-6 md:p-8">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
                Top story · last 72 hours
              </p>

              <div className="flex flex-wrap items-center gap-2 mb-4">
                <Badge
                  variant="outline"
                  className="bg-[var(--negative)]/10 text-[var(--negative)] border-[var(--negative)]/20 font-semibold"
                >
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Breaking now
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "font-medium",
                    isRising
                      ? "bg-[var(--negative)]/10 text-[var(--negative)] border-[var(--negative)]/20"
                      : "bg-[var(--positive)]/10 text-[var(--positive)] border-[var(--positive)]/20"
                  )}
                >
                  {isRising ? (
                    <TrendingUp className="h-3 w-3 mr-1" />
                  ) : (
                    <TrendingDown className="h-3 w-3 mr-1" />
                  )}
                  {isRising ? "+" : ""}
                  {metrics.momentum}% vs prior 72h
                </Badge>
              </div>

              <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-2 text-balance leading-tight">
                {headline}
              </h2>
              <p className="text-muted-foreground text-lg md:text-xl mb-6 leading-relaxed">
                {subheadline}
              </p>

              <div className="flex flex-wrap gap-6 md:gap-8 mb-6">
                <div className="flex flex-col">
                  <span className="text-2xl md:text-3xl font-bold text-foreground tabular-nums">
                    {metrics.total}
                  </span>
                  <span className="text-sm text-muted-foreground">signals in window</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-2xl md:text-3xl font-bold text-[var(--negative)] tabular-nums">
                    {Math.round(metrics.negativeShare * 100)}%
                  </span>
                  <span className="text-sm text-muted-foreground">negative share</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-2xl md:text-3xl font-bold text-foreground tabular-nums">
                    {metrics.sourcesReporting}
                  </span>
                  <span className="text-sm text-muted-foreground">sources reporting</span>
                </div>
              </div>

              {cloud}

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <div className="w-full sm:w-auto">
                  <Button
                    onClick={() => onExploreIssues(categorySlug)}
                    className="gap-2 w-full sm:w-auto"
                    size="lg"
                  >
                    View {category} in issues
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                  <p className="mt-1.5 text-xs text-muted-foreground max-w-sm">
                    Issues list uses the global time filter: {issueTableTimeLabel} (lead metrics above: last 72h).
                  </p>
                </div>
                <Button
                  onClick={() => onNavigateToCategory?.(categorySlug)}
                  variant="outline"
                  size="lg"
                  className="gap-2 w-full sm:w-auto"
                >
                  Review in AI classifications
                </Button>
              </div>

              <p className="mt-4 text-xs text-muted-foreground leading-relaxed max-w-2xl">
                Urgency ranks categories using recent volume, momentum, impact, and
                source diversity in a 72h window — not raw post count alone.{" "}
                <MethodologyTriggerButton
                  label="How this is read"
                  onClick={() => setInterpretationOpen(true)}
                  className="h-auto p-0 text-xs"
                />
                {" · "}
                <MethodologyTriggerButton
                  label="Urgency formula"
                  onClick={() => setUrgencyOpen(true)}
                  className="h-auto p-0 text-xs"
                />
              </p>
            </div>

            <div className="lg:w-96 lg:pl-6 lg:border-l lg:border-border">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Representative issues
              </h3>
              <div className="space-y-3">
                {topIssues.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sample issues available.</p>
                ) : (
                  topIssues.slice(0, 3).map((issue, index) => (
                    <div
                      key={issue.id}
                      className="bg-secondary/50 rounded-lg p-3 hover:bg-secondary transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-xs font-bold text-muted-foreground shrink-0">
                          #{index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          {issue.url ? (
                            <a
                              href={issue.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm font-medium text-foreground hover:text-primary line-clamp-2 flex items-start gap-1"
                            >
                              <span className="flex-1">{issue.title}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground" />
                            </a>
                          ) : (
                            <p className="text-sm font-medium text-foreground line-clamp-2">
                              {issue.title}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-muted-foreground">{issue.source}</span>
                            <span className="text-xs text-muted-foreground">
                              Impact: {issue.impact_score.toFixed(1)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <button
                onClick={() => onExploreIssues(categorySlug)}
                className="mt-4 text-sm font-medium text-primary hover:text-primary/80 flex items-center gap-1 transition-colors"
              >
                View all {category} issues
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      <InterpretationContractDialog
        open={interpretationOpen}
        onOpenChange={setInterpretationOpen}
      />
      <UrgencyModelDialog open={urgencyOpen} onOpenChange={setUrgencyOpen} />
    </>
  )
}

// Utility to compute hero insight from realtime insights data
export function computeHeroInsight(
  realtimeInsights: Array<{
    category: { name: string; slug: string; color: string }
    nowCount: number
    previousCount: number
    momentum: number
    avgImpact: number
    negativeRatio: number
    sourceDiversity: number
    urgencyScore: number
    llmCategoryBreakdown?: Array<{ slug: string; count: number }>
    llmUnclassifiedCount?: number
    topIssues: Array<{
      id: string
      title: string
      url: string | null
      source: string
      impact_score: number
    }>
  }>
): HeroInsightProps["topInsight"] {
  if (!realtimeInsights || realtimeInsights.length === 0) {
    return null
  }

  const top = realtimeInsights[0]

  const insight =
    top.category.name.toLowerCase() === "other" && realtimeInsights.length > 1
      ? realtimeInsights[1]
      : top

  const isRising = insight.momentum > 0
  const momentumText = isRising ? "escalating" : "stabilizing"
  const negativeText =
    insight.negativeRatio > 70
      ? "overwhelmingly negative"
      : insight.negativeRatio > 50
        ? "mostly negative"
        : "mixed"

  return {
    category: insight.category.name,
    categorySlug: insight.category.slug,
    headline: `${insight.category.name} issues are ${momentumText}`,
    subheadline: `${insight.nowCount} signals in the last 72 hours with ${negativeText} sentiment. ${insight.sourceDiversity} source${insight.sourceDiversity !== 1 ? "s" : ""} reporting this theme.`,
    metrics: {
      total: insight.nowCount,
      negativeShare: insight.negativeRatio / 100,
      momentum: insight.momentum,
      sourcesReporting: insight.sourceDiversity,
    },
    llmCategoryBreakdown: insight.llmCategoryBreakdown ?? [],
    llmUnclassifiedCount: insight.llmUnclassifiedCount ?? 0,
    topIssues: insight.topIssues,
  }
}

interface LlmClassificationCloudProps {
  categoryName: string
  categorySlug: string
  breakdown: Array<{ slug: string; count: number }>
  unclassifiedCount: number
  classifiedSharePct: number
  maxCount: number
  onDrill?: (categorySlug: string, llmCategorySlug: string) => void
}

// Pill sizing for the cloud — three tiers based on share of the largest pill,
// so the largest LLM category visually anchors the group regardless of total volume.
function pillSizeClass(count: number, maxCount: number): string {
  if (maxCount <= 0) return "text-xs px-2 py-0.5"
  const share = count / maxCount
  if (share >= 0.66) return "text-sm px-2.5 py-1 font-semibold"
  if (share >= 0.33) return "text-xs px-2.5 py-1 font-medium"
  return "text-xs px-2 py-0.5"
}

function LlmClassificationCloud({
  categoryName,
  categorySlug,
  breakdown,
  unclassifiedCount,
  classifiedSharePct,
  maxCount,
  onDrill,
}: LlmClassificationCloudProps) {
  if (breakdown.length === 0 && unclassifiedCount === 0) return null

  const isInteractive = typeof onDrill === "function"

  return (
    <div className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        {/*
          Heading reads "LLM category" so the noun matches the
          CATEGORY_ENUM field name in lib/classification/taxonomy.ts.
          {categoryName} interpolates the heuristic Topic name (e.g.
          "Bug") — disjoint namespace. See docs/ARCHITECTURE.md §6.0.
        */}
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Inside {categoryName} · LLM category
        </h3>
        {breakdown.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {classifiedSharePct}% classified
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {breakdown.map(({ slug, count }) => {
          const palette = llmCategoryPalette(slug)
          const label = llmCategoryLabel(slug)
          const sizeCls = pillSizeClass(count, maxCount)
          const sharedCls = cn(
            "inline-flex items-center gap-1.5 rounded-full border border-transparent transition-colors",
            sizeCls,
            palette.bg,
            palette.text,
          )
          if (isInteractive) {
            return (
              <button
                key={slug}
                type="button"
                onClick={() => onDrill?.(categorySlug, slug)}
                className={cn(
                  sharedCls,
                  "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
                  palette.ring,
                )}
                title={`Show ${label} classifications inside ${categoryName}`}
                aria-label={`Show ${label} classifications inside ${categoryName} (${count})`}
              >
                <span>{label}</span>
                <span className="tabular-nums opacity-80">{count}</span>
              </button>
            )
          }
          return (
            <span key={slug} className={sharedCls}>
              <span>{label}</span>
              <span className="tabular-nums opacity-80">{count}</span>
            </span>
          )
        })}
        {unclassifiedCount > 0 && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border bg-muted/40 text-muted-foreground text-xs px-2 py-0.5"
            title="Issues in this window without an LLM classification yet"
          >
            <span>Unclassified</span>
            <span className="tabular-nums">{unclassifiedCount}</span>
          </span>
        )}
      </div>
    </div>
  )
}
