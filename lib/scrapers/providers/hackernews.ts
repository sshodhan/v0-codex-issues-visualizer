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
  HACKERNEWS_QUERY_PARAMS,
  evaluateCodexRelevance,
} from "@/lib/scrapers/relevance"

// Algolia treats the `query` as AND-by-default. The required phrase + a
// scoped `optionalWords` list gives us OR semantics over the shared
// CODEX_CORE_PHRASES in relevance.ts — a single source of truth with
// Reddit.
const RELEVANCE_DEBUG = process.env.RELEVANCE_DEBUG === "1"

export async function scrapeHackerNews(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  const params = new URLSearchParams({
    query: HACKERNEWS_QUERY_PARAMS.query,
    tags: "story",
    hitsPerPage: "75",
    optionalWords: HACKERNEWS_QUERY_PARAMS.optional.join(" "),
  })

  try {
    const response = await fetchWithRetry(
      `https://hn.algolia.com/api/v1/search?${params.toString()}`
    )
    if (!response.ok) return issues

    const data = await response.json()
    const hits = data?.hits || []

    for (const hit of hits) {
      const normalizedTitle = normalizeWhitespace(hit.title || "")
      const normalizedContent = normalizeWhitespace(hit.story_text || hit.comment_text || "")
      const content = `${normalizedTitle} ${normalizedContent}`

      const relevance = evaluateCodexRelevance(content)
      if (!relevance.passed) {
        if (RELEVANCE_DEBUG) {
          console.debug(`[relevance] hackernews rejected: ${relevance.decision}`)
        }
        continue
      }
      if (isLowValueIssue(normalizedTitle, normalizedContent)) continue

      const { sentiment, score: sentimentScore } = analyzeSentiment(content)

      issues.push({
        source_id: source.id,
        category_id: categorizeIssue(content, categories),
        external_id: hit.objectID,
        title: normalizedTitle.slice(0, 500),
        content: normalizedContent.slice(0, 2000),
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        author: hit.author,
        sentiment,
        sentiment_score: sentimentScore,
        impact_score: calculateImpactScore(
          hit.points || 0,
          hit.num_comments || 0,
          sentiment
        ),
        upvotes: hit.points || 0,
        comments_count: hit.num_comments || 0,
        published_at: hit.created_at,
        relevance_reason: relevance.relevanceReason,
      })
    }
  } catch (error) {
    console.error("Error scraping HN:", error)
  }

  return issues
}
