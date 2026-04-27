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
  const query = encodeURIComponent(REDDIT_SCOPED_QUERY_TERMS.join(" OR "))

  for (const subreddit of SUBREDDITS) {
    try {
      const response = await fetchWithRetry(
        `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&sort=new&limit=25&restrict_sr=on&type=link`
      )

      if (!response.ok) continue

      const data = await response.json()
      const posts = data?.data?.children || []

      for (const post of posts) {
        const { title, selftext, author, score, num_comments, created_utc, id } = post.data
        const normalizedTitle = normalizeWhitespace(title || "")
        const normalizedContent = normalizeWhitespace(selftext || "")
        const content = `${normalizedTitle} ${normalizedContent}`

        const relevance = evaluateCodexRelevance(content)
        if (!relevance.passed) {
          if (RELEVANCE_DEBUG) {
            console.debug(`[relevance] reddit/${subreddit} rejected: ${relevance.decision}`)
          }
          continue
        }
        if (isLowValueIssue(normalizedTitle, normalizedContent)) continue

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
      }
    } catch (error) {
      console.error(`Error scraping r/${subreddit}:`, error)
    }
  }

  return issues
}
