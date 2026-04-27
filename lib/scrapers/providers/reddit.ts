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

const SUBREDDITS = [
  "OpenAI",
  "MachineLearning",
  "programming",
  "learnprogramming",
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
  const query = encodeURIComponent(`(${REDDIT_SCOPED_QUERY_TERMS.join(" OR ")})`)

  for (const subreddit of SUBREDDITS) {
    const requestUrl = new URL(`https://www.reddit.com/r/${subreddit}/search.json`)
    requestUrl.searchParams.set("q", query)
    requestUrl.searchParams.set("sort", "new")
    requestUrl.searchParams.set("limit", "25")
    requestUrl.searchParams.set("restrict_sr", "on")
    requestUrl.searchParams.set("type", "link")

    const requestPath = `${requestUrl.pathname}?sort=${requestUrl.searchParams.get("sort")}&limit=${requestUrl.searchParams.get("limit")}&restrict_sr=${requestUrl.searchParams.get("restrict_sr")}&type=${requestUrl.searchParams.get("type")}`
    const summary = {
      found: 0,
      rejected: 0,
      error: 0,
    }
    let responseStatus: number | null = null

    try {
      const response = await fetchWithRetry(requestUrl.toString())
      responseStatus = response.status

      if (!response.ok) {
        summary.error += 1
        console.error("reddit scrape request failed", {
          source: source.slug,
          subreddit,
          status: response.status,
          requestPath,
        })
        continue
      }

      const data = await response.json()
      const posts = data?.data?.children || []

      for (const post of posts) {
        const { title, selftext, author, score, num_comments, created_utc, id } = post.data
        const normalizedTitle = normalizeWhitespace(title || "")
        const normalizedContent = normalizeWhitespace(selftext || "")
        const content = `${normalizedTitle} ${normalizedContent}`

        const relevance = evaluateCodexRelevance(content)
        if (!relevance.passed) {
          summary.rejected += 1
          if (RELEVANCE_DEBUG) {
            console.debug(`[relevance] reddit/${subreddit} rejected: ${relevance.decision}`)
          }
          continue
        }
        if (isLowValueIssue(normalizedTitle, normalizedContent)) {
          summary.rejected += 1
          continue
        }

        const { sentiment, score: sentimentScore, keyword_presence } = analyzeSentiment(content)

        issues.push({
          source_id: source.id,
          source_slug: source.slug,
          category_id: categorizeIssue(content, categories),
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
      summary.error += 1
      console.error(`Error scraping r/${subreddit}:`, error)
    } finally {
      console.info("reddit scrape summary", {
        source: source.slug,
        subreddit,
        status: responseStatus,
        found: summary.found,
        rejected: summary.rejected,
        error: summary.error,
      })
    }
  }

  return issues
}
