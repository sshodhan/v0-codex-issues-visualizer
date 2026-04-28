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

// Stack Exchange API allows ~300 unauthenticated requests per IP per day,
// which is plenty for our cadence. A SE API key (no OAuth) raises this to
// 10k/day if provided via env.
const SITE = "stackoverflow"
const TAGS = ["openai-api", "github-copilot", "openai-codex"]

interface SOQuestion {
  question_id: number
  title: string
  body?: string
  link: string
  owner?: { display_name?: string }
  score: number
  answer_count: number
  view_count?: number
  creation_date: number
  tags?: string[]
  is_answered?: boolean
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ")
}

export async function scrapeStackOverflow(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  const apiKey = process.env.STACK_EXCHANGE_KEY

  for (const tag of TAGS) {
    try {
      const params = new URLSearchParams({
        order: "desc",
        sort: "creation",
        tagged: tag,
        site: SITE,
        pagesize: "30",
        filter: "withbody", // include question body in payload
      })
      if (apiKey) params.set("key", apiKey)

      const response = await fetchWithRetry(
        `https://api.stackexchange.com/2.3/questions?${params.toString()}`
      )
      if (!response.ok) continue

      const data = (await response.json()) as { items?: SOQuestion[] }
      const items = data?.items || []

      for (const item of items) {
        const normalizedTitle = normalizeWhitespace(item.title || "")
        const normalizedContent = normalizeWhitespace(stripHtml(item.body || ""))
        const content = `${normalizedTitle} ${normalizedContent}`

        if (!isLikelyCodexIssue(content)) continue
        if (isLowValueIssue(normalizedTitle, normalizedContent)) continue

        const { sentiment, score: sentimentScore, keyword_presence } = analyzeSentiment(content)

        issues.push({
          source_id: source.id,
          source_slug: source.slug,
          category_id: categorizeIssue(normalizedTitle, normalizedContent, categories)?.categoryId,
          external_id: String(item.question_id),
          title: normalizedTitle.slice(0, 500),
          content: normalizedContent.slice(0, 2000),
          url: item.link,
          author: item.owner?.display_name || null,
          sentiment,
          sentiment_score: sentimentScore,
          keyword_presence,
          impact_score: calculateImpactScore(
            item.score || 0,
            item.answer_count || 0,
            sentiment,
            source.slug
          ),
          upvotes: item.score || 0,
          comments_count: item.answer_count || 0,
          published_at: new Date(item.creation_date * 1000).toISOString(),
          _raw: item,
        })
      }
    } catch (error) {
      console.error(`Error scraping Stack Overflow tag ${tag}:`, error)
    }
  }

  return issues
}
