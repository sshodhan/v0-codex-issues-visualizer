import { createAdminClient } from "@/lib/supabase/admin"
import type { Issue, Source, Category } from "@/lib/types"

// Keywords to search for Codex-related content
const CODEX_KEYWORDS = [
  "codex",
  "openai codex",
  "github copilot",
  "copilot",
  "codex cli",
  "chatgpt codex",
  "openai/codex",
  "ai coding",
  "code completion",
  "ai assistant code",
]

const NON_PRODUCT_NOISE_PATTERNS = [
  /\bcodex\s+sinaiticus\b/i,
  /\bcodex\s+alimentarius\b/i,
  /\bcodex\s+seraphinianus\b/i,
  /\bbook\s+codex\b/i,
  /\bmanuscript\b/i,
]

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function isLikelyCodexIssue(text: string): boolean {
  const normalized = normalizeWhitespace(text.toLowerCase())
  if (!normalized) return false

  const hasKeyword = CODEX_KEYWORDS.some((keyword) =>
    normalized.includes(keyword.toLowerCase())
  )
  if (!hasKeyword) return false

  return !NON_PRODUCT_NOISE_PATTERNS.some((pattern) => pattern.test(normalized))
}

function isLowValueIssue(title: string, content: string): boolean {
  const normalizedTitle = normalizeWhitespace(title.toLowerCase())
  const normalizedContent = normalizeWhitespace(content.toLowerCase())

  if (normalizedTitle.length < 8) return true
  if (normalizedTitle === "[deleted]" || normalizedTitle === "[removed]") return true
  if (normalizedContent === "[deleted]" || normalizedContent === "[removed]") return true

  return false
}

// Simple keyword-based sentiment analysis
function analyzeSentiment(text: string): {
  sentiment: "positive" | "negative" | "neutral"
  score: number
} {
  const positiveWords = [
    "love",
    "great",
    "amazing",
    "awesome",
    "excellent",
    "fantastic",
    "helpful",
    "useful",
    "best",
    "perfect",
    "wonderful",
    "impressive",
    "revolutionary",
    "game-changer",
    "productive",
    "efficient",
    "fast",
    "accurate",
  ]
  const negativeWords = [
    "hate",
    "terrible",
    "awful",
    "bad",
    "worst",
    "broken",
    "useless",
    "bug",
    "error",
    "crash",
    "slow",
    "expensive",
    "frustrating",
    "annoying",
    "disappointing",
    "wrong",
    "fail",
    "issue",
    "problem",
    "doesn't work",
    "not working",
  ]

  const lowerText = text.toLowerCase()
  let positiveCount = 0
  let negativeCount = 0

  positiveWords.forEach((word) => {
    if (lowerText.includes(word)) positiveCount++
  })
  negativeWords.forEach((word) => {
    if (lowerText.includes(word)) negativeCount++
  })

  const total = positiveCount + negativeCount
  if (total === 0) return { sentiment: "neutral", score: 0 }

  const score = (positiveCount - negativeCount) / total
  if (score > 0.2) return { sentiment: "positive", score: Math.min(score, 0.99) }
  if (score < -0.2)
    return { sentiment: "negative", score: Math.max(score, -0.99) }
  return { sentiment: "neutral", score }
}

type CategoryPattern = {
  phrase: string
  weight: number
  wholeWord?: boolean
}

const CATEGORY_PATTERNS: Record<string, CategoryPattern[]> = {
  bug: [
    { phrase: "bug", weight: 2, wholeWord: true },
    { phrase: "error", weight: 2, wholeWord: true },
    { phrase: "crash", weight: 3, wholeWord: true },
    { phrase: "broken", weight: 2, wholeWord: true },
    { phrase: "not working", weight: 3 },
    { phrase: "fails to", weight: 2 },
    { phrase: "stack trace", weight: 2 },
    { phrase: "exception", weight: 2, wholeWord: true },
  ],
  performance: [
    { phrase: "slow", weight: 2, wholeWord: true },
    { phrase: "performance", weight: 2, wholeWord: true },
    { phrase: "latency", weight: 2, wholeWord: true },
    { phrase: "lag", weight: 2, wholeWord: true },
    { phrase: "high cpu", weight: 3 },
    { phrase: "memory leak", weight: 3 },
    { phrase: "timed out", weight: 2 },
    { phrase: "timeout", weight: 2, wholeWord: true },
  ],
  "feature-request": [
    { phrase: "feature request", weight: 4 },
    { phrase: "would be nice", weight: 3 },
    { phrase: "please add", weight: 3 },
    { phrase: "can you add", weight: 3 },
    { phrase: "i wish", weight: 2 },
    { phrase: "missing feature", weight: 2 },
    { phrase: "enhancement", weight: 2, wholeWord: true },
    { phrase: "roadmap", weight: 1, wholeWord: true },
  ],
  documentation: [
    { phrase: "docs", weight: 2, wholeWord: true },
    { phrase: "documentation", weight: 3, wholeWord: true },
    { phrase: "readme", weight: 2, wholeWord: true },
    { phrase: "tutorial", weight: 2, wholeWord: true },
    { phrase: "guide", weight: 2, wholeWord: true },
    { phrase: "example", weight: 1, wholeWord: true },
    { phrase: "unclear", weight: 1, wholeWord: true },
  ],
  "ux-ui": [
    { phrase: "ui", weight: 1, wholeWord: true },
    { phrase: "ux", weight: 1, wholeWord: true },
    { phrase: "interface", weight: 2, wholeWord: true },
    { phrase: "layout", weight: 2, wholeWord: true },
    { phrase: "button", weight: 1, wholeWord: true },
    { phrase: "confusing", weight: 2, wholeWord: true },
    { phrase: "workflow", weight: 2, wholeWord: true },
  ],
  integration: [
    { phrase: "integration", weight: 3, wholeWord: true },
    { phrase: "plugin", weight: 2, wholeWord: true },
    { phrase: "extension", weight: 2, wholeWord: true },
    { phrase: "vscode", weight: 2, wholeWord: true },
    { phrase: "jetbrains", weight: 2, wholeWord: true },
    { phrase: "connect", weight: 1, wholeWord: true },
    { phrase: "github action", weight: 2 },
  ],
  api: [
    { phrase: "api", weight: 3, wholeWord: true },
    { phrase: "endpoint", weight: 2, wholeWord: true },
    { phrase: "http", weight: 2, wholeWord: true },
    { phrase: "request", weight: 2, wholeWord: true },
    { phrase: "response", weight: 2, wholeWord: true },
    { phrase: "status code", weight: 2 },
    { phrase: "rate limit", weight: 3 },
    { phrase: "429", weight: 2, wholeWord: true },
  ],
  pricing: [
    { phrase: "price", weight: 2, wholeWord: true },
    { phrase: "pricing", weight: 3, wholeWord: true },
    { phrase: "cost", weight: 2, wholeWord: true },
    { phrase: "expensive", weight: 3, wholeWord: true },
    { phrase: "subscription", weight: 2, wholeWord: true },
    { phrase: "plan", weight: 1, wholeWord: true },
    { phrase: "billing", weight: 2, wholeWord: true },
  ],
  security: [
    { phrase: "security", weight: 3, wholeWord: true },
    { phrase: "privacy", weight: 3, wholeWord: true },
    { phrase: "vulnerability", weight: 3, wholeWord: true },
    { phrase: "leak", weight: 2, wholeWord: true },
    { phrase: "token", weight: 2, wholeWord: true },
    { phrase: "secret", weight: 2, wholeWord: true },
    { phrase: "exposed", weight: 2, wholeWord: true },
  ],
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function countMatches(text: string, phrase: string, wholeWord = false): number {
  const pattern = wholeWord
    ? `\\b${escapeRegExp(phrase)}\\b`
    : escapeRegExp(phrase)

  return (text.match(new RegExp(pattern, "g")) || []).length
}

// Auto-categorize based on weighted keyword scoring
function categorizeIssue(
  text: string,
  categories: Category[]
): string | undefined {
  const normalizedText = text.toLowerCase()

  const scores = Object.entries(CATEGORY_PATTERNS).map(([slug, patterns]) => {
    const score = patterns.reduce((acc, pattern) => {
      return acc + countMatches(normalizedText, pattern.phrase, pattern.wholeWord) * pattern.weight
    }, 0)

    return { slug, score }
  })

  const ranked = scores
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  const top = ranked[0]
  if (!top) {
    return categories.find((c) => c.slug === "other")?.id
  }

  // Avoid over-classifying weak single-word matches as hard categories.
  if (top.score < 2) {
    return categories.find((c) => c.slug === "other")?.id
  }

  const category = categories.find((c) => c.slug === top.slug)
  if (category) {
    return category.id
  }

  return categories.find((c) => c.slug === "other")?.id
}

// Calculate impact score based on engagement metrics
function calculateImpactScore(
  upvotes: number,
  comments: number,
  sentiment: string
): number {
  const engagementScore = Math.min(
    Math.log10((upvotes || 1) + (comments || 1) * 2) * 2,
    8
  )
  const sentimentBoost = sentiment === "negative" ? 1.5 : 1
  return Math.min(Math.round(engagementScore * sentimentBoost), 10)
}

// Reddit scraper using JSON API
export async function scrapeReddit(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  const subreddits = ["OpenAI", "MachineLearning", "programming", "learnprogramming"]

  for (const subreddit of subreddits) {
    try {
      const query = encodeURIComponent(
        '(codex OR copilot OR "openai codex" OR "codex cli")'
      )
      const response = await fetch(
        `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&sort=new&limit=25&restrict_sr=on&type=link`,
        {
          headers: {
            "User-Agent": "CodexIssuesTracker/1.0",
          },
        }
      )

      if (!response.ok) continue

      const data = await response.json()
      const posts = data?.data?.children || []

      for (const post of posts) {
        const { title, selftext, author, score, num_comments, created_utc, id } = post.data
        const normalizedTitle = normalizeWhitespace(title || "")
        const normalizedContent = normalizeWhitespace(selftext || "")
        const content = `${normalizedTitle} ${normalizedContent}`

        if (!isLikelyCodexIssue(content)) continue
        if (isLowValueIssue(normalizedTitle, normalizedContent)) continue

        const { sentiment, score: sentimentScore } = analyzeSentiment(content)

        issues.push({
          source_id: source.id,
          category_id: categorizeIssue(content, categories),
          external_id: id,
          title: normalizedTitle.slice(0, 500),
          content: normalizedContent.slice(0, 2000),
          url: `https://reddit.com${post.data.permalink}`,
          author,
          sentiment,
          sentiment_score: sentimentScore,
          impact_score: calculateImpactScore(score, num_comments, sentiment),
          upvotes: score,
          comments_count: num_comments,
          published_at: new Date(created_utc * 1000).toISOString(),
        })
      }
    } catch (error) {
      console.error(`Error scraping r/${subreddit}:`, error)
    }
  }

  return issues
}

// Hacker News scraper using Algolia API
export async function scrapeHackerNews(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []

  try {
    const response = await fetch(
      `https://hn.algolia.com/api/v1/search?query=codex%20copilot%20openai&tags=story&hitsPerPage=50`
    )

    if (!response.ok) return issues

    const data = await response.json()
    const hits = data?.hits || []

    for (const hit of hits) {
      const normalizedTitle = normalizeWhitespace(hit.title || "")
      const normalizedContent = normalizeWhitespace(hit.story_text || "")
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

// GitHub Issues scraper
export async function scrapeGitHub(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  const repos = ["microsoft/vscode", "github/copilot-docs"]

  for (const repo of repos) {
    try {
      const query = encodeURIComponent(
        `repo:${repo} is:issue (codex OR copilot OR "openai codex" OR "codex cli") in:title,body`
      )
      const response = await fetch(
        `https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=25`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "CodexIssuesTracker/1.0",
          },
        }
      )

      if (!response.ok) continue

      const data = await response.json()
      const items = data?.items || []

      for (const item of items) {
        const normalizedTitle = normalizeWhitespace(item.title || "")
        const normalizedContent = normalizeWhitespace(item.body || "")
        const content = `${normalizedTitle} ${normalizedContent}`

        if (!isLikelyCodexIssue(content)) continue
        if (isLowValueIssue(normalizedTitle, normalizedContent)) continue

        const { sentiment, score: sentimentScore } = analyzeSentiment(content)
        const reactions = item.reactions?.total_count || 0
        const comments = item.comments || 0

        issues.push({
          source_id: source.id,
          category_id: categorizeIssue(content, categories),
          external_id: String(item.id),
          title: normalizedTitle.slice(0, 500),
          content: normalizedContent.slice(0, 2000),
          url: item.html_url,
          author: item.user?.login,
          sentiment,
          sentiment_score: sentimentScore,
          impact_score: calculateImpactScore(reactions, comments, sentiment),
          upvotes: reactions,
          comments_count: comments,
          published_at: item.created_at,
        })
      }
    } catch (error) {
      console.error(`Error scraping GitHub ${repo}:`, error)
    }
  }

  return issues
}

function dedupeIssues(issues: Partial<Issue>[]): Partial<Issue>[] {
  const seen = new Set<string>()
  const unique: Partial<Issue>[] = []

  for (const issue of issues) {
    const title = normalizeWhitespace((issue.title || "").toLowerCase())
    const author = normalizeWhitespace((issue.author || "").toLowerCase())
    const day = issue.published_at ? issue.published_at.slice(0, 10) : "unknown-day"
    const key = `${issue.source_id}|${title}|${author}|${day}`

    if (seen.has(key)) continue
    seen.add(key)
    unique.push(issue)
  }

  return unique
}

// Main scrape function that runs all scrapers
export async function runAllScrapers(): Promise<{
  total: number
  added: number
  errors: string[]
}> {
  const supabase = createAdminClient()
  const errors: string[] = []
  let totalFound = 0
  let totalAdded = 0

  // Get sources and categories
  const { data: sources } = await supabase.from("sources").select("*")
  const { data: categories } = await supabase.from("categories").select("*")

  if (!sources || !categories) {
    return { total: 0, added: 0, errors: ["Failed to load sources/categories"] }
  }

  const scrapers: Record<
    string,
    (s: Source, c: Category[]) => Promise<Partial<Issue>[]>
  > = {
    reddit: scrapeReddit,
    hackernews: scrapeHackerNews,
    github: scrapeGitHub,
  }

  for (const source of sources) {
    const scraper = scrapers[source.slug]
    if (!scraper) continue

    // Create scrape log
    const { data: log } = await supabase
      .from("scrape_logs")
      .insert({
        source_id: source.id,
        status: "running",
      })
      .select()
      .single()

    try {
      const issues = dedupeIssues(await scraper(source, categories))
      totalFound += issues.length

      // Upsert issues
      for (const issue of issues) {
        const { error } = await supabase.from("issues").upsert(issue, {
          onConflict: "source_id,external_id",
          ignoreDuplicates: false,
        })

        if (!error) totalAdded++
      }

      // Update log
      if (log) {
        await supabase
          .from("scrape_logs")
          .update({
            status: "completed",
            issues_found: issues.length,
            issues_added: issues.length,
            completed_at: new Date().toISOString(),
          })
          .eq("id", log.id)
      }
    } catch (error) {
      const errorMsg = `Error scraping ${source.name}: ${error}`
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
    }
  }

  return { total: totalFound, added: totalAdded, errors }
}
