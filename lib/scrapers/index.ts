import { createAdminClient } from "@/lib/supabase/admin"
import type { Issue, Source, Category } from "@/lib/types"
import { dedupeIssues } from "@/lib/scrapers/shared"
import { scrapeReddit } from "@/lib/scrapers/providers/reddit"
import { scrapeHackerNews } from "@/lib/scrapers/providers/hackernews"
import { scrapeGitHub } from "@/lib/scrapers/providers/github"
import { scrapeGitHubDiscussions } from "@/lib/scrapers/providers/github-discussions"
import { scrapeStackOverflow } from "@/lib/scrapers/providers/stackoverflow"
import { scrapeOpenAICommunity } from "@/lib/scrapers/providers/openai-community"

// Re-export provider scrapers + shared utilities so callers can hit a single
// entry point regardless of how the project is structured later.
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
  bySource: Array<{ source: string; found: number; added: number; status: "success" | "error"; error?: string }>
}

async function upsertIssueObservation(
  supabase: ReturnType<typeof createAdminClient>,
  issue: Partial<Issue>
): Promise<boolean> {
  const observation = {
    ...issue,
    scraped_at: issue.scraped_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  }

  const { error } = await supabase.rpc("upsert_issue_observation", {
    issue_payload: observation,
  })

  if (!error) return true

  // Backward compatibility for environments where migration 006 has not run yet.
  const missingRpc = error.code === "PGRST202" || /upsert_issue_observation/i.test(error.message)
  if (!missingRpc) return false

  const { error: fallbackError } = await supabase.from("issues").upsert(observation, {
    onConflict: "source_id,external_id",
    ignoreDuplicates: false,
  })

  return !fallbackError
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

  // Run sources in parallel; each scraper handles its own retries internally.
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
          const success = await upsertIssueObservation(supabase, issue)
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

  return { total: totalFound, added: totalAdded, errors, bySource }
}

// Run a single source by slug. Useful for /api/scrape/:source style triggers
// and for ad-hoc backfills without re-running every provider.
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
    const success = await upsertIssueObservation(supabase, issue)
    if (success) added++
  }

  return {
    total: issues.length,
    added,
    errors: [],
    bySource: [{ source: source.slug, found: issues.length, added, status: "success" }],
  }
}
