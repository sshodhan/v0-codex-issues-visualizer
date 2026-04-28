import type { Category, Issue, Source } from "@/lib/types"
import {
  analyzeSentiment,
  calculateImpactScore,
  categorizeIssue,
  fetchWithRetry,
  isLowValueIssue,
  normalizeWhitespace,
} from "@/lib/scrapers/shared"
import {
  REDDIT_SCOPED_QUERY_TERMS,
  evaluateCodexRelevance,
} from "@/lib/scrapers/relevance"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

const COMPONENT = "reddit-scraper"

// Topical subreddits only. r/programming and r/learnprogramming were
// dropped because the broad single-term "codex" query (see
// REDDIT_SCOPED_QUERY_TERMS in lib/scrapers/relevance.ts) returns mostly
// off-topic posts there (project names, jargon, unrelated tools), which
// wastes the per-subreddit limit=25 budget. The subreddits below are
// either Codex/OpenAI-specific or AI-adjacent enough that the bare
// "codex" query plus the strict evaluator is high-signal.
const SUBREDDITS = [
  "OpenAI",
  "MachineLearning",
  "ChatGPTCoding",
  "OpenaiCodex",
  "ArtificialIntelligence",
]

const RELEVANCE_DEBUG = process.env.RELEVANCE_DEBUG === "1"

export async function scrapeReddit(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  const query = REDDIT_SCOPED_QUERY_TERMS.join(" OR ")

  for (const subreddit of SUBREDDITS) {
    const requestUrl = new URL(`https://www.reddit.com/r/${subreddit}/search.json`)
    requestUrl.searchParams.set("q", query)
    requestUrl.searchParams.set("sort", "new")
    requestUrl.searchParams.set("limit", "25")
    requestUrl.searchParams.set("restrict_sr", "on")
    requestUrl.searchParams.set("type", "link")

    // Sanitized path for logs: drop the q payload so structured logs
    // don't carry the (potentially long) query string.
    const safeUrl = new URL(requestUrl.toString())
    safeUrl.searchParams.delete("q")
    const requestPath = `${safeUrl.pathname}${safeUrl.search}`

    const summary = {
      candidates: 0,
      found: 0,
      relevanceRejected: 0,
      lowValueRejected: 0,
      errors: 0,
    }
    let responseStatus: number | null = null

    try {
      const response = await fetchWithRetry(requestUrl.toString())
      responseStatus = response.status

      if (!response.ok) {
        summary.errors += 1
        logServer({
          component: COMPONENT,
          event: "request_failed",
          level: "error",
          data: {
            source: source.slug,
            subreddit,
            status: response.status,
            requestPath,
          },
        })
        continue
      }

      const data = await response.json()
      const posts = data?.data?.children || []
      summary.candidates = posts.length

      for (const post of posts) {
        const { title, selftext, author, score, num_comments, created_utc, id } = post.data
        const normalizedTitle = normalizeWhitespace(title || "")
        const normalizedContent = normalizeWhitespace(selftext || "")
        const content = `${normalizedTitle} ${normalizedContent}`

        const relevance = evaluateCodexRelevance(content)
        if (!relevance.passed) {
          summary.relevanceRejected += 1
          if (RELEVANCE_DEBUG) {
            console.debug(`[relevance] reddit/${subreddit} rejected: ${relevance.decision}`)
          }
          continue
        }
        if (isLowValueIssue(normalizedTitle, normalizedContent)) {
          summary.lowValueRejected += 1
          continue
        }

        const { sentiment, score: sentimentScore, keyword_presence } = analyzeSentiment(content)

        issues.push({
          source_id: source.id,
          source_slug: source.slug,
          category_id: categorizeIssue(normalizedTitle, normalizedContent, categories)?.categoryId,
          external_id: id,
          title: normalizedTitle.slice(0, 500),
          content: normalizedContent.slice(0, 2000),
          url: `https://reddit.com${post.data.permalink}`,
          author,
          sentiment,
          sentiment_score: sentimentScore,
          keyword_presence,
          impact_score: calculateImpactScore(score, num_comments, sentiment, source.slug),
          upvotes: score,
          comments_count: num_comments,
          published_at: new Date(created_utc * 1000).toISOString(),
          relevance_reason: relevance.relevanceReason,
          _raw: post.data,
        })
        summary.found += 1
      }
    } catch (error) {
      summary.errors += 1
      logServerError(COMPONENT, "scrape_threw", error, {
        source: source.slug,
        subreddit,
        requestPath,
      })
    } finally {
      logServer({
        component: COMPONENT,
        event: "scrape_summary",
        data: {
          source: source.slug,
          subreddit,
          status: responseStatus,
          requestPath,
          ...summary,
        },
      })
    }
  }

  return issues
}
