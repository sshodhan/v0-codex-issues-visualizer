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

// Repos that are likely to surface Codex/Copilot issues. Order matters: we
// stop early when rate-limited so the most relevant repos come first.
const REPOS = [
  "openai/codex",
  "openai/openai-cookbook",
  "microsoft/vscode-copilot-release",
  "github/copilot-docs",
  "microsoft/vscode",
]

export async function scrapeGitHub(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  const token = process.env.GITHUB_TOKEN
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json",
  }
  if (token) headers.Authorization = `Bearer ${token}`

  for (const repo of REPOS) {
    try {
      const query = encodeURIComponent(
        `repo:${repo} is:issue (codex OR copilot OR "openai codex" OR "codex cli") in:title,body`
      )
      const response = await fetchWithRetry(
        `https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=30`,
        { headers }
      )

      if (!response.ok) {
        // GitHub returns 422 for invalid queries (e.g. repo not found) - skip
        // quietly. Other errors already retried by fetchWithRetry.
        if (response.status === 422 || response.status === 404) continue
        if (response.status === 403) break // rate limited; stop the loop
        continue
      }

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
