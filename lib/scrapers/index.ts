import { createAdminClient } from "@/lib/supabase/admin"
import type { Issue, Source, Category, SentimentLabel } from "@/lib/types"
import { dedupeIssues } from "@/lib/scrapers/shared"
import { scrapeReddit } from "@/lib/scrapers/providers/reddit"
import { scrapeHackerNews } from "@/lib/scrapers/providers/hackernews"
import { scrapeGitHub } from "@/lib/scrapers/providers/github"
import { scrapeGitHubDiscussions } from "@/lib/scrapers/providers/github-discussions"
import { scrapeStackOverflow } from "@/lib/scrapers/providers/stackoverflow"
import { scrapeOpenAICommunity } from "@/lib/scrapers/providers/openai-community"
import {
  recordObservation,
  recordEngagementSnapshot,
  recordRevision,
  recordIngestionArtifact,
} from "@/lib/storage/evidence"
import {
  recordSentiment,
  recordCategory,
  recordImpact,
} from "@/lib/storage/derivations"
import { attachToCluster } from "@/lib/storage/clusters"

export {
  scrapeReddit,
  scrapeHackerNews,
  scrapeGitHub,
  scrapeGitHubDiscussions,
  scrapeStackOverflow,
  scrapeOpenAICommunity,
}
export * from "@/lib/scrapers/shared"

type Scraper = (s: Source, c: Category[]) => Promise<Partial<Issue>[]>

const SCRAPERS: Record<string, Scraper> = {
  reddit: scrapeReddit,
  hackernews: scrapeHackerNews,
  github: scrapeGitHub,
  "github-discussions": scrapeGitHubDiscussions,
  stackoverflow: scrapeStackOverflow,
  "openai-community": scrapeOpenAICommunity,
}

interface RunSummary {
  total: number
  added: number
  errors: string[]
  refresh?: {
    degraded: boolean
    failed: number
    duration_ms: number
    views: Array<{ name: string; status: string; duration_ms?: number; error?: string }>
  }
  bySource: Array<{ source: string; found: number; added: number; status: "success" | "error"; error?: string }>
}

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Persist one captured issue across the three layers:
 * 1. evidence (observation + revision if title/content changed +
 *    engagement snapshot + raw upstream artifact)
 * 2. derivation (sentiment, category, impact)
 * 3. aggregation (cluster membership)
 *
 * Each write is a SECURITY DEFINER RPC; no direct table mutation.
 * Failure of any derivation/cluster write does not undo the evidence
 * insert — raw capture is independent of enrichment correctness.
 *
 * Revision detection: before recording the observation, SELECT the
 * existing row (if any). If title/content/author have diverged from
 * what we just captured, append to observation_revisions. The
 * observation row itself is never updated.
 */
async function persistIssueRecord(
  supabase: AdminClient,
  issue: Partial<Issue>,
): Promise<boolean> {
  if (!issue.source_id || !issue.external_id || !issue.title) return false

  // 3.1a Evidence — detect pre-existing observation so we can distinguish
  // "first sighting" from "rescrape with edits". Select before insert so
  // the diff is computed against the frozen original.
  const { data: existing } = await supabase
    .from("observations")
    .select("id, title, content, author")
    .eq("source_id", issue.source_id)
    .eq("external_id", issue.external_id)
    .maybeSingle()

  const observationId = await recordObservation(supabase, {
    source_id: issue.source_id,
    external_id: issue.external_id,
    title: issue.title,
    content: issue.content ?? null,
    url: issue.url ?? null,
    author: issue.author ?? null,
    published_at: issue.published_at ?? null,
    upvotes: issue.upvotes ?? 0,
    comments_count: issue.comments_count ?? 0,
  })
  if (!observationId) return false

  // Revision capture: if the observation already existed and any of
  // title/content/author have changed, append to observation_revisions.
  // observations.title/content are frozen at first capture (P1-10 fix).
  if (existing) {
    const titleChanged = (existing.title ?? null) !== (issue.title ?? null)
    const contentChanged = (existing.content ?? null) !== (issue.content ?? null)
    const authorChanged = (existing.author ?? null) !== (issue.author ?? null)
    if (titleChanged || contentChanged || authorChanged) {
      await recordRevision(supabase, observationId, {
        title: issue.title ?? null,
        content: issue.content ?? null,
        author: issue.author ?? null,
      })
    }
  }

  // Engagement snapshot — append every time; the time series is the point.
  await recordEngagementSnapshot(
    supabase,
    observationId,
    issue.upvotes ?? 0,
    issue.comments_count ?? 0,
  )

  // Ingestion artifact — opt-in via provider `_raw`. Providers that don't
  // set _raw skip this step; artifact capture is per-provider retrofit.
  if (issue._raw !== undefined) {
    await recordIngestionArtifact(
      supabase,
      issue.source_id,
      issue.external_id,
      new Date().toISOString(),
      issue._raw,
    )
  }

  // 3.1b Derivation
  if (issue.sentiment) {
    await recordSentiment(supabase, observationId, {
      label: issue.sentiment as SentimentLabel,
      score: issue.sentiment_score ?? 0,
      keyword_presence: 0,
    })
  }
  if (issue.category_id) {
    await recordCategory(supabase, observationId, issue.category_id, 1.0)
  }
  if (typeof issue.impact_score === "number") {
    await recordImpact(supabase, observationId, issue.impact_score, {
      upvotes: issue.upvotes ?? 0,
      comments_count: issue.comments_count ?? 0,
      sentiment_label: (issue.sentiment ?? "neutral") as SentimentLabel,
    })
  }

  // 3.1c Aggregation
  await attachToCluster(supabase, observationId, issue.title)

  return true
}

async function refreshMaterializedViews(
  supabase: AdminClient,
): Promise<RunSummary["refresh"] | undefined> {
  const { data, error } = await supabase.rpc("refresh_materialized_views", {
    max_budget_ms: 15_000,
  })
  if (error) console.error("[cron] refresh_materialized_views failed:", error)
  if (error || !data) return undefined

  const parsed = data as {
    degraded?: boolean
    failed?: number
    duration_ms?: number
    views?: Array<{ name: string; status: string; duration_ms?: number; error?: string }>
  }
  return {
    degraded: parsed.degraded ?? false,
    failed: parsed.failed ?? 0,
    duration_ms: parsed.duration_ms ?? 0,
    views: parsed.views ?? [],
  }
}

export async function runAllScrapers(): Promise<RunSummary> {
  const supabase = createAdminClient()
  const errors: string[] = []
  const bySource: RunSummary["bySource"] = []
  let totalFound = 0
  let totalAdded = 0

  const { data: sources } = await supabase.from("sources").select("*")
  const { data: categories } = await supabase.from("categories").select("*")

  if (!sources || !categories) {
    return {
      total: 0,
      added: 0,
      errors: ["Failed to load sources/categories"],
      bySource: [],
    }
  }

  const sourceRuns = sources
    .filter((source: Source) => SCRAPERS[source.slug])
    .map(async (source: Source) => {
      const scraper = SCRAPERS[source.slug]

      const { data: log } = await supabase
        .from("scrape_logs")
        .insert({ source_id: source.id, status: "running" })
        .select()
        .single()

      try {
        const issues = dedupeIssues(await scraper(source, categories))
        let added = 0

        for (const issue of issues) {
          const success = await persistIssueRecord(supabase, issue)
          if (success) added++
        }

        if (log) {
          await supabase
            .from("scrape_logs")
            .update({
              status: "completed",
              issues_found: issues.length,
              issues_added: added,
              completed_at: new Date().toISOString(),
            })
            .eq("id", log.id)
        }

        totalFound += issues.length
        totalAdded += added
        bySource.push({
          source: source.slug,
          found: issues.length,
          added,
          status: "success",
        })
      } catch (error) {
        const errorMsg = `Error scraping ${source.name}: ${error instanceof Error ? error.message : String(error)}`
        errors.push(errorMsg)

        if (log) {
          await supabase
            .from("scrape_logs")
            .update({
              status: "failed",
              error_message: errorMsg,
              completed_at: new Date().toISOString(),
            })
            .eq("id", log.id)
        }

        bySource.push({
          source: source.slug,
          found: 0,
          added: 0,
          status: "error",
          error: errorMsg,
        })
      }
    })

  await Promise.all(sourceRuns)

  // Rebuild materialized views at cron end so the dashboard picks up the new
  // scrape in one step. See docs/ARCHITECTURE.md v10 §3.1c.
  const refresh = await refreshMaterializedViews(supabase)

  return { total: totalFound, added: totalAdded, errors, bySource, refresh }
}

export async function runScraper(slug: string): Promise<RunSummary> {
  const supabase = createAdminClient()

  const { data: sources } = await supabase
    .from("sources")
    .select("*")
    .eq("slug", slug)
    .limit(1)
  const { data: categories } = await supabase.from("categories").select("*")

  if (!sources || sources.length === 0 || !categories) {
    return {
      total: 0,
      added: 0,
      errors: [`Source not found: ${slug}`],
      bySource: [],
    }
  }

  const source = sources[0] as Source
  const scraper = SCRAPERS[source.slug]
  if (!scraper) {
    return {
      total: 0,
      added: 0,
      errors: [`No scraper registered for source: ${slug}`],
      bySource: [],
    }
  }

  const issues = dedupeIssues(await scraper(source, categories))
  let added = 0
  for (const issue of issues) {
    const success = await persistIssueRecord(supabase, issue)
    if (success) added++
  }

  await refreshMaterializedViews(supabase)

  return {
    total: issues.length,
    added,
    errors: [],
    bySource: [{ source: source.slug, found: issues.length, added, status: "success" }],
  }
}
