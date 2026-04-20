import type { Category, Issue, Source } from "@/lib/types"
import {
  analyzeSentiment,
  calculateImpactScore,
  categorizeIssue,
  fetchWithRetry,
  isLikelyCodexIssue,
  isLowValueIssue,
  normalizeWhitespace,
} from "@/lib/scrapers/shared"

// Algolia search treats the `query` as AND-by-default. Using `optionalWords`
// gives us boolean OR semantics across our keyword set so we don't lose
// stories that only mention one of them.
const QUERY = ""
const OPTIONAL = ["codex", "copilot", "openai", "codex cli", "openai codex"]

export async function scrapeHackerNews(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  const params = new URLSearchParams({
    query: QUERY,
    tags: "story",
    hitsPerPage: "75",
    optionalWords: OPTIONAL.join(" "),
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

      if (!isLikelyCodexIssue(content)) continue
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
      })
    }
  } catch (error) {
    console.error("Error scraping HN:", error)
  }

  return issues
}
