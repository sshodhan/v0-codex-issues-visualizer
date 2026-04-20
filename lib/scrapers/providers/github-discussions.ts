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
          number
          title
          body
          url
          createdAt
          upvoteCount
          author { login }
          comments { totalCount }
          repository { nameWithOwner }
        }
      }
    }
  }
`

interface DiscussionNode {
  __typename: string
  id: string
  number: number
  title: string | null
  body: string | null
  url: string
  createdAt: string
  upvoteCount: number
  author: { login: string } | null
  comments: { totalCount: number }
  repository: { nameWithOwner: string }
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
      const q = `repo:${repo} codex copilot "codex cli" "openai codex" in:title,body`
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

      const data = await response.json()
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
