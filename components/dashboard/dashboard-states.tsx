"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { 
  Loader2, 
  AlertTriangle, 
  Database, 
  RefreshCw,
  Settings,
  FileQuestion,
  Sparkles
} from "lucide-react"

// Skeleton loading state for stat cards
export function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn("bg-card border-border", className)}>
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-2 flex-1">
            <div className="h-4 w-24 bg-muted animate-pulse rounded" />
            <div className="h-8 w-32 bg-muted animate-pulse rounded mt-1" />
            <div className="h-3 w-48 bg-muted animate-pulse rounded mt-2" />
          </div>
          <div className="h-10 w-10 bg-muted animate-pulse rounded-lg" />
        </div>
      </CardContent>
    </Card>
  )
}

// Full page loading state
interface LoadingStateProps {
  message?: string
  className?: string
}

export function LoadingState({ 
  message = "Loading dashboard...", 
  className 
}: LoadingStateProps) {
  return (
    <div className={cn(
      "flex min-h-[50vh] items-center justify-center",
      className
    )}>
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="relative">
          <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl animate-pulse" />
          <div className="relative bg-card border border-border rounded-full p-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </div>
        <p className="text-muted-foreground font-medium">{message}</p>
      </div>
    </div>
  )
}

// Empty state - no data yet
interface EmptyStateProps {
  onRefresh?: () => void
  isRefreshing?: boolean
  className?: string
}

export function EmptyState({ 
  onRefresh, 
  isRefreshing = false,
  className 
}: EmptyStateProps) {
  return (
    <div className={cn(
      "flex min-h-[50vh] flex-col items-center justify-center gap-6 px-4",
      className
    )}>
      <div className="relative">
        <div className="absolute inset-0 bg-primary/10 rounded-full blur-2xl" />
        <div className="relative bg-card border border-border rounded-2xl p-6">
          <Database className="h-12 w-12 text-muted-foreground" />
        </div>
      </div>
      
      <div className="text-center max-w-md">
        <h2 className="text-2xl font-bold text-foreground mb-2">
          Ready to Get Started
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          No issues have been collected yet. Click the button below to scrape feedback 
          from Reddit, Hacker News, GitHub, and other sources.
        </p>
      </div>
      
      {onRefresh && (
        <Button 
          onClick={onRefresh} 
          disabled={isRefreshing} 
          size="lg"
          className="gap-2"
        >
          {isRefreshing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Scraping sources...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Start Collecting Feedback
            </>
          )}
        </Button>
      )}
    </div>
  )
}

// Error state - something went wrong
interface ErrorStateProps {
  title?: string
  message?: string
  errorCode?: string | number
  onRetry?: () => void
  isRetrying?: boolean
  showSettings?: boolean
  className?: string
}

export function ErrorState({ 
  title = "Something went wrong",
  message = "We encountered an error while loading the dashboard. Please try again.",
  errorCode,
  onRetry, 
  isRetrying = false,
  showSettings = false,
  className 
}: ErrorStateProps) {
  return (
    <div className={cn(
      "flex min-h-[50vh] flex-col items-center justify-center gap-6 px-4",
      className
    )}>
      <div className="relative">
        <div className="absolute inset-0 bg-[var(--negative)]/10 rounded-full blur-2xl" />
        <div className="relative bg-card border border-[var(--negative)]/30 rounded-2xl p-6">
          <AlertTriangle className="h-12 w-12 text-[var(--negative)]" />
        </div>
      </div>
      
      <div className="text-center max-w-md">
        <h2 className="text-2xl font-bold text-foreground mb-2">
          {title}
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          {message}
        </p>
        {errorCode && (
          <p className="text-sm text-muted-foreground mt-2 font-mono">
            Error code: {errorCode}
          </p>
        )}
      </div>
      
      <div className="flex flex-wrap items-center justify-center gap-3">
        {onRetry && (
          <Button 
            onClick={onRetry} 
            disabled={isRetrying} 
            variant="default"
            className="gap-2"
          >
            {isRetrying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Retrying...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                Try Again
              </>
            )}
          </Button>
        )}
        {showSettings && (
          <Button variant="outline" className="gap-2" asChild>
            <a href="/settings">
              <Settings className="h-4 w-4" />
              Check Configuration
            </a>
          </Button>
        )}
      </div>
    </div>
  )
}

// Configuration error state - missing env vars or integration
interface ConfigurationErrorProps {
  missingItems?: string[]
  onConfigure?: () => void
  className?: string
}

export function ConfigurationError({ 
  missingItems = ["Database connection"],
  onConfigure,
  className 
}: ConfigurationErrorProps) {
  return (
    <div className={cn(
      "flex min-h-[50vh] flex-col items-center justify-center gap-6 px-4",
      className
    )}>
      <div className="relative">
        <div className="absolute inset-0 bg-[var(--insight-warning)]/10 rounded-full blur-2xl" />
        <div className="relative bg-card border border-[var(--insight-warning)]/30 rounded-2xl p-6">
          <Settings className="h-12 w-12 text-[var(--insight-warning)]" />
        </div>
      </div>
      
      <div className="text-center max-w-md">
        <h2 className="text-2xl font-bold text-foreground mb-2">
          Configuration Required
        </h2>
        <p className="text-muted-foreground leading-relaxed mb-4">
          The dashboard needs a few things set up before it can work properly.
        </p>
        
        {missingItems.length > 0 && (
          <div className="bg-secondary/50 rounded-lg p-4 text-left">
            <p className="text-sm font-medium text-foreground mb-2">Missing configuration:</p>
            <ul className="text-sm text-muted-foreground space-y-1">
              {missingItems.map((item, index) => (
                <li key={index} className="flex items-center gap-2">
                  <FileQuestion className="h-4 w-4 text-[var(--insight-warning)]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      
      {onConfigure && (
        <Button onClick={onConfigure} className="gap-2">
          <Settings className="h-4 w-4" />
          Configure Now
        </Button>
      )}
    </div>
  )
}

// Loading skeleton for the entire dashboard
export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      {/* Hero skeleton */}
      <Card className="bg-card border-border">
        <CardContent className="p-8">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
            <div className="flex-1">
              <div className="flex gap-2 mb-4">
                <div className="h-6 w-24 bg-muted animate-pulse rounded-full" />
                <div className="h-6 w-32 bg-muted animate-pulse rounded-full" />
              </div>
              <div className="h-10 w-3/4 bg-muted animate-pulse rounded mb-2" />
              <div className="h-6 w-full bg-muted animate-pulse rounded mb-6" />
              <div className="flex gap-6 mb-6">
                <div className="flex flex-col gap-1">
                  <div className="h-8 w-12 bg-muted animate-pulse rounded" />
                  <div className="h-4 w-16 bg-muted animate-pulse rounded" />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="h-8 w-12 bg-muted animate-pulse rounded" />
                  <div className="h-4 w-16 bg-muted animate-pulse rounded" />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="h-8 w-12 bg-muted animate-pulse rounded" />
                  <div className="h-4 w-16 bg-muted animate-pulse rounded" />
                </div>
              </div>
              <div className="h-12 w-48 bg-muted animate-pulse rounded" />
            </div>
            <div className="lg:w-96">
              <div className="h-4 w-32 bg-muted animate-pulse rounded mb-3" />
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="bg-secondary/50 rounded-lg p-3">
                    <div className="h-4 w-full bg-muted animate-pulse rounded mb-2" />
                    <div className="h-3 w-24 bg-muted animate-pulse rounded" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stat cards skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>

      {/* Filter bar skeleton */}
      <Card className="bg-card border-border">
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-4">
            <div className="h-10 w-64 bg-muted animate-pulse rounded" />
            <div className="h-10 w-48 bg-muted animate-pulse rounded" />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
