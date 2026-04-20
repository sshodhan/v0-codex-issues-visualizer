import { createAdminClient } from "@/lib/supabase/admin"
import type { Issue, Source, Category } from "@/lib/types"

// Keywords to search for Codex-related content
const CODEX_KEYWORDS = [
  "codex",
  "openai codex",
  "github copilot",
  "copilot",
  "ai coding",
  "code completion",
  "ai assistant code",
]

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

// Auto-categorize based on content keywords
function categorizeIssue(
  text: string,
  categories: Category[]
): string | undefined {
  const lowerText = text.toLowerCase()

  const categoryKeywords: Record<string, string[]> = {
    bug: ["bug", "error", "crash", "broken", "not working", "issue", "problem"],
    performance: ["slow", "performance", "lag", "memory", "cpu", "speed"],
    "feature-request": [
      "feature",
      "request",
      "wish",
      "would be nice",
      "suggestion",
      "add",
    ],
    documentation: ["docs", "documentation", "guide", "tutorial", "example"],
    "ux-ui": ["ui", "ux", "interface", "design", "layout", "button"],
    integration: [
      "integration",
      "api",
      "plugin",
      "extension",
      "connect",
      "vscode",
    ],
    pricing: ["price", "pricing", "cost", "expensive", "subscription", "plan"],
    security: ["security", "privacy", "data", "leak", "vulnerability"],
  }

  for (const [slug, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some((kw) => lowerText.includes(kw))) {
      const category = categories.find((c) => c.slug === slug)
      if (category) return category.id
    }
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
      const response = await fetch(
        `https://www.reddit.com/r/${subreddit}/search.json?q=codex+OR+copilot&sort=new&limit=25&restrict_sr=on`,
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
        const { title, selftext, url, author, score, num_comments, created_utc, id } = post.data
        const content = `${title} ${selftext || ""}`
        const { sentiment, score: sentimentScore } = analyzeSentiment(content)

        issues.push({
          source_id: source.id,
          category_id: categorizeIssue(content, categories),
          external_id: id,
          title: title?.slice(0, 500),
          content: selftext?.slice(0, 2000),
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
      const content = `${hit.title} ${hit.story_text || ""}`
      const { sentiment, score: sentimentScore } = analyzeSentiment(content)

      issues.push({
        source_id: source.id,
        category_id: categorizeIssue(content, categories),
        external_id: hit.objectID,
        title: hit.title?.slice(0, 500),
        content: hit.story_text?.slice(0, 2000),
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
      const response = await fetch(
        `https://api.github.com/search/issues?q=repo:${repo}+codex+OR+copilot+is:issue&sort=created&order=desc&per_page=25`,
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
        const content = `${item.title} ${item.body || ""}`
        const { sentiment, score: sentimentScore } = analyzeSentiment(content)
        const reactions = item.reactions?.total_count || 0
        const comments = item.comments || 0

        issues.push({
          source_id: source.id,
          category_id: categorizeIssue(content, categories),
          external_id: String(item.id),
          title: item.title?.slice(0, 500),
          content: item.body?.slice(0, 2000),
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
      const issues = await scraper(source, categories)
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
