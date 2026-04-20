import type { Category } from "../types.ts"
import { evaluateCodexRelevance } from "./relevance.ts"
import { COMPETITOR_KEYWORDS } from "../analytics/competitors.ts"
import { NEGATIVE_WORDS, POSITIVE_WORDS } from "../analytics/sentiment-lexicon.ts"

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function isLikelyCodexIssue(text: string): boolean {
  return evaluateCodexRelevance(text).passed
}

export function isLowValueIssue(title: string, content: string): boolean {
  const normalizedTitle = normalizeWhitespace(title.toLowerCase())
  const normalizedContent = normalizeWhitespace(content.toLowerCase())

  if (normalizedTitle.length < 8) return true
  if (normalizedTitle === "[deleted]" || normalizedTitle === "[removed]") return true
  if (normalizedContent === "[deleted]" || normalizedContent === "[removed]") return true

  return false
}

export function detectCompetitorMentions(text: string): string[] {
  const lower = text.toLowerCase()
  const found = new Set<string>()
  for (const [competitor, phrases] of Object.entries(COMPETITOR_KEYWORDS)) {
    if (phrases.some((p) => lower.includes(p.trim()))) found.add(competitor)
  }
  return Array.from(found)
}

// Ingest-time sentiment classifier. Consumes the canonical polarity lexicon
// from lib/analytics/sentiment-lexicon so the ingest-side and the
// mention-level classifier in lib/analytics/competitive share one source of
// truth. Closes P0-2 (topic-noun contamination) as a side effect — topic
// nouns like "bug", "error", "issue", "problem", "fail" are absent from the
// canonical lexicon by construction, so bug-category posts are no longer
// pre-loaded with negative sentiment regardless of tone.
export function analyzeSentiment(text: string): {
  sentiment: "positive" | "negative" | "neutral"
  score: number
} {
  const lowerText = text.toLowerCase()
  const tokens = lowerText.match(/[a-z']+/g) ?? []

  let positiveCount = 0
  let negativeCount = 0

  for (const token of tokens) {
    if (POSITIVE_WORDS.has(token)) positiveCount++
    else if (NEGATIVE_WORDS.has(token)) negativeCount++
  }

  // Multi-word negative phrases the tokenizer cannot see directly.
  if (/\bdoesn'?t\s+work\b/.test(lowerText)) negativeCount++
  if (/\bnot\s+working\b/.test(lowerText)) negativeCount++

  const total = positiveCount + negativeCount
  if (total === 0) return { sentiment: "neutral", score: 0 }

  const score = (positiveCount - negativeCount) / total
  if (score > 0.2) return { sentiment: "positive", score: Math.min(score, 0.99) }
  if (score < -0.2) return { sentiment: "negative", score: Math.max(score, -0.99) }
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
    { phrase: "regression", weight: 3, wholeWord: true },
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

export function categorizeIssue(
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

  if (top.score < 2) {
    return categories.find((c) => c.slug === "other")?.id
  }

  const category = categories.find((c) => c.slug === top.slug)
  if (category) return category.id

  return categories.find((c) => c.slug === "other")?.id
}

export function calculateImpactScore(
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

const DEFAULT_HEADERS: HeadersInit = {
  "User-Agent": "CodexIssuesTracker/1.0 (+https://github.com/sshodhan/v0-codex-issues-visualizer)",
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: { retries?: number; baseDelayMs?: number; timeoutMs?: number } = {}
): Promise<Response> {
  const { retries = 3, baseDelayMs = 500, timeoutMs = 15000 } = options
  let attempt = 0
  let lastError: unknown

  while (attempt <= retries) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...DEFAULT_HEADERS, ...(init.headers || {}) },
        signal: controller.signal,
      })
      clearTimeout(timer)

      // Retry on transient server errors and rate limits
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`)
      }
      return response
    } catch (error) {
      clearTimeout(timer)
      lastError = error
      if (attempt === retries) break
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200
      await new Promise((r) => setTimeout(r, delay))
      attempt++
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export function dedupeIssues<T extends {
  source_id?: string
  title?: string
  author?: string | null
  published_at?: string | null
}>(issues: T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []

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
