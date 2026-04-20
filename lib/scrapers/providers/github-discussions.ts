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

// GitHub Discussions live behind the GraphQL API — the REST /search/issues
// endpoint used by the `github` scraper does not index discussions. Since the
// openai/codex repository uses Discussions as its primary user feedback
// channel, scraping it separately is necessary to avoid a large blind spot.
const REPOS = [
  "openai/codex",
  "openai/openai-cookbook",
  "microsoft/vscode-copilot-release",
]

const DISCUSSION_QUERY = /* GraphQL */ `
  query($q: String!) {
    search(query: $q, type: DISCUSSION, first: 30) {
      nodes {
        __typename
        ... on Discussion {
          id
          title
          body
          url
          createdAt
          upvoteCount
          author { login }
          comments { totalCount }
        }
      }
    }
  }
`

interface DiscussionNode {
  __typename: string
  id: string
  title: string | null
  body: string | null
  url: string
  createdAt: string
  upvoteCount: number
  author: { login: string } | null
  comments: { totalCount: number }
}

export async function scrapeGitHubDiscussions(
  source: Source,
  categories: Category[]
): Promise<Partial<Issue>[]> {
  const issues: Partial<Issue>[] = []
  const token = process.env.GITHUB_TOKEN
  // GraphQL requires authentication; without a token we can't scrape anything.
  if (!token) return issues

  const headers: HeadersInit = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
  }

  for (const repo of REPOS) {
    try {
      // GitHub search AND's bare keywords — wrap in parens with OR to match
      // the existing reddit/github REST providers' query style.
      const q = `repo:${repo} (codex OR copilot OR "openai codex" OR "codex cli") in:title,body`
      const response = await fetchWithRetry(
        "https://api.github.com/graphql",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ query: DISCUSSION_QUERY, variables: { q } }),
        }
      )

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) break
        continue
      }

      // GraphQL returns 200 with a populated `errors` array on rate-limit or
      // schema problems. Without this branch those failures look like an
      // empty result set.
      const data = await response.json()
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        console.error(
          `GitHub Discussions GraphQL errors for ${repo}:`,
          data.errors
        )
        continue
      }
      const nodes: DiscussionNode[] = data?.data?.search?.nodes || []

      for (const node of nodes) {
        if (node.__typename !== "Discussion") continue

        const normalizedTitle = normalizeWhitespace(node.title || "")
        const normalizedContent = normalizeWhitespace(node.body || "")
        const content = `${normalizedTitle} ${normalizedContent}`

        if (!isLikelyCodexIssue(content)) continue
        if (isLowValueIssue(normalizedTitle, normalizedContent)) continue

        const { sentiment, score: sentimentScore } = analyzeSentiment(content)
        const upvotes = node.upvoteCount || 0
        const comments = node.comments?.totalCount || 0

        issues.push({
          source_id: source.id,
          category_id: categorizeIssue(content, categories),
          external_id: node.id,
          title: normalizedTitle.slice(0, 500),
          content: normalizedContent.slice(0, 2000),
          url: node.url,
          author: node.author?.login || null,
          sentiment,
          sentiment_score: sentimentScore,
          impact_score: calculateImpactScore(upvotes, comments, sentiment),
          upvotes,
          comments_count: comments,
          published_at: node.createdAt,
        })
      }
    } catch (error) {
      console.error(`Error scraping GitHub Discussions ${repo}:`, error)
    }
  }

  return issues
}
