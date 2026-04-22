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

// community.openai.com is a Discourse forum. Discourse exposes a public
// JSON search endpoint that returns matching topics with blurbs, which gives
// us enough signal to classify and score each thread without an extra
// per-topic fetch.
const BASE_URL = "https://community.openai.com"
// Intentionally omits "copilot" — the term pulls in Microsoft / GitHub
// Copilot threads that aren't about OpenAI Codex, mirroring the Reddit
// P0-1 noise problem in BUGS.md.
const SEARCH_TERMS = ["codex", "codex cli", "openai codex"]

interface DiscoursePost {
  topic_id: number
  post_number: number
  blurb?: string
  username?: string
  like_count?: number
}

interface DiscourseTopic {
  id: number
  title: string
  slug: string
  posts_count: number
  reply_count?: number
  like_count: number
  views?: number
  created_at: string
  last_posted_at?: string
  category_id?: number
  tags?: string[]
}

interface DiscourseSearchResponse {
  posts?: DiscoursePost[]
  topics?: DiscourseTopic[]
}

export async function scrapeOpenAICommunity(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  // Dedup across search terms — the same topic routinely matches multiple
  // terms (e.g. "codex" and "openai codex"), and classifying it twice wastes
  // work even though the DB upsert would collapse them later.
  const seenTopicIds = new Set<number>()

  for (const term of SEARCH_TERMS) {
    try {
      const params = new URLSearchParams({
        q: term,
        include_blurbs: "true",
      })
      const response = await fetchWithRetry(
        `${BASE_URL}/search.json?${params.toString()}`,
        { headers: { Accept: "application/json" } }
      )
      if (!response.ok) continue

      const data = (await response.json()) as DiscourseSearchResponse
      const topics = data?.topics || []
      const posts = data?.posts || []

      // Discourse returns posts ordered by relevance, not thread position,
      // so a matched reply can appear before its OP. We need post_number=1
      // to attribute author/content to the topic starter.
      const opByTopic = new Map<number, DiscoursePost>()
      for (const post of posts) {
        if (post.post_number === 1) opByTopic.set(post.topic_id, post)
      }

      for (const topic of topics) {
        if (seenTopicIds.has(topic.id)) continue
        seenTopicIds.add(topic.id)

        const op = opByTopic.get(topic.id)
        const normalizedTitle = normalizeWhitespace(topic.title || "")
        const normalizedContent = normalizeWhitespace(op?.blurb || "")
        const content = `${normalizedTitle} ${normalizedContent}`

        if (!isLikelyCodexIssue(content)) continue
        if (isLowValueIssue(normalizedTitle, normalizedContent)) continue

        const { sentiment, score: sentimentScore } = analyzeSentiment(content)
        // Discourse's native engagement signals: likes on the OP and reply
        // count on the topic. Views is 10×+ inflated vs. likes so we stick
        // with likes for an apples-to-apples comparison across sources.
        const upvotes = topic.like_count || 0
        const replyCount =
          typeof topic.reply_count === "number"
            ? topic.reply_count
            : Math.max(0, (topic.posts_count || 1) - 1)

        issues.push({
          source_id: source.id,
          category_id: categorizeIssue(content, categories),
          external_id: String(topic.id),
          title: normalizedTitle.slice(0, 500),
          content: normalizedContent.slice(0, 2000),
          url: `${BASE_URL}/t/${topic.slug}/${topic.id}`,
          author: op?.username || null,
          sentiment,
          sentiment_score: sentimentScore,
          impact_score: calculateImpactScore(upvotes, replyCount, sentiment, source.slug),
          upvotes,
          comments_count: replyCount,
          published_at: topic.created_at,
          _raw: topic,
        })
      }
    } catch (error) {
      console.error(`Error scraping OpenAI community "${term}":`, error)
    }
  }

  return issues
}
