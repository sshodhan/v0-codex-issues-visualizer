import { createAdminClient } from "@/lib/supabase/admin"
import type { Issue, Source, Category } from "@/lib/types"
import { dedupeIssues, buildIssueClusterKey } from "@/lib/scrapers/shared"
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

// Postgres unique_violation SQLSTATE — emitted when the partial unique index
// on (cluster_key) WHERE is_canonical rejects a second canonical for the same
// cluster, or when (source_id, external_id) collides under concurrent inserts.
const PG_UNIQUE_VIOLATION = "23505"

type SupabaseError = { code?: string } | null

async function findCanonicalId(
  supabase: ReturnType<typeof createAdminClient>,
  clusterKey: string
): Promise<string | null> {
  const { data } = await supabase
    .from("issues")
    .select("id")
    .eq("cluster_key", clusterKey)
    .eq("is_canonical", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.id ?? null
}

async function insertMemberAndBump(
  supabase: ReturnType<typeof createAdminClient>,
  issue: Partial<Issue>,
  clusterKey: string,
  canonicalId: string
): Promise<boolean> {
  const { error: insertError } = await supabase.from("issues").insert({
    ...issue,
    cluster_key: clusterKey,
    canonical_issue_id: canonicalId,
    is_canonical: false,
    frequency_count: 1,
  })
  if (insertError) return false

  const { error: rpcError } = await supabase.rpc(
    "increment_canonical_frequency",
    { canonical_id: canonicalId }
  )
  return !rpcError
}

async function persistIssueWithClustering(
  supabase: ReturnType<typeof createAdminClient>,
  issue: Partial<Issue>
): Promise<boolean> {
  if (!issue.source_id || !issue.external_id || !issue.title) return false

  const clusterKey = buildIssueClusterKey(issue.title)

  // If this exact external row already exists, update mutable content only.
  // We intentionally do NOT rewrite cluster_key / canonical linkage /
  // frequency_count here — title edits would otherwise move the row to a new
  // cluster without rebalancing the old canonical's count, creating drift.
  // Handling title edits end-to-end is tracked as P1-10 in docs/BUGS.md.
  const { data: existing } = await supabase
    .from("issues")
    .select("id")
    .eq("source_id", issue.source_id)
    .eq("external_id", issue.external_id)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from("issues")
      .update(issue)
      .eq("id", existing.id)
    return !error
  }

  // New external row. If a canonical already exists for this cluster, attach
  // as a non-canonical member and atomically bump the canonical's frequency.
  const existingCanonicalId = await findCanonicalId(supabase, clusterKey)
  if (existingCanonicalId) {
    return insertMemberAndBump(supabase, issue, clusterKey, existingCanonicalId)
  }

  // Attempt to seed the cluster as its canonical. The partial unique index
  // idx_issues_unique_canonical_per_cluster ensures at most one canonical
  // per cluster_key survives under concurrent writers.
  const { error: canonicalInsertError } = await supabase.from("issues").insert({
    ...issue,
    cluster_key: clusterKey,
    canonical_issue_id: null,
    is_canonical: true,
    frequency_count: 1,
  })

  if (!canonicalInsertError) return true

  // If another writer won the canonical slot, retry as a member pointed at
  // them. Any other error (validation, FK, RLS, etc.) is surfaced as a
  // failure so the scraper records the drop rather than silently succeeding.
  if ((canonicalInsertError as SupabaseError)?.code !== PG_UNIQUE_VIOLATION) {
    return false
  }

  const winnerCanonicalId = await findCanonicalId(supabase, clusterKey)
  if (!winnerCanonicalId) return false
  return insertMemberAndBump(supabase, issue, clusterKey, winnerCanonicalId)
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
          const persisted = await persistIssueWithClustering(supabase, issue)
          if (persisted) added++
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
    const persisted = await persistIssueWithClustering(supabase, issue)
    if (persisted) added++
  }

  return {
    total: issues.length,
    added,
    errors: [],
    bySource: [{ source: source.slug, found: issues.length, added, status: "success" }],
  }
}
