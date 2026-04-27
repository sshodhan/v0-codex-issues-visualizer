import type { Category } from "../types.ts"
import { evaluateCodexRelevance } from "./relevance.ts"
import { COMPETITOR_KEYWORDS } from "../analytics/competitors.ts"
import { NEGATIVE_WORDS, POSITIVE_WORDS } from "../analytics/sentiment-lexicon.ts"

const NEGATIVE_KEYWORD_PATTERNS = [
  /\bbugs?\b/g,
  /\berrors?\b/g,
  /\bcrash(?:es|ed|ing)?\b/g,
  /\bbroken\b/g,
  /\bissues?\b/g,
  /\bproblems?\b/g,
  /\bregressions?\b/g,
  /\bnot\s+working\b/g,
  /\bdoesn['’]?t\s+work\b/g,
  /\bfail(?:s|ed|ing|ure|ures)?\b/g,
]

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

export function calculateKeywordPresence(text: string): number {
  const lowerText = text.toLowerCase()

  return NEGATIVE_KEYWORD_PATTERNS.reduce((count, pattern) => {
    return count + (lowerText.match(pattern) || []).length
  }, 0)
}

// Ingest-time sentiment classifier. Consumes the canonical polarity lexicon
// from lib/analytics/sentiment-lexicon so the ingest-side and the
// mention-level classifier in lib/analytics/competitive share one source of
// truth. Closes P0-2 (topic-noun contamination): topic nouns like "bug",
// "error", "issue", "problem", "fail" are absent from the canonical lexicon
// by construction, so bug-category posts are no longer pre-loaded with
// negative sentiment regardless of tone. Topic-noun *presence* (which is
// still a useful signal for urgency/triage, just not a polarity signal) is
// surfaced separately via `keyword_presence`.
export function analyzeSentiment(text: string): {
  sentiment: "positive" | "negative" | "neutral"
  score: number
  keyword_presence: number
} {
  // Normalize U+2019 (right single quotation mark, the "curly" apostrophe) to
  // the ASCII apostrophe before tokenizing. Web/iOS text overwhelmingly uses
  // the curly form, and the tokenizer regex [a-z']+ only matches straight
  // apostrophes — without this normalization, titles like "can’t connect" or
  // "doesn’t work" would tokenize wrong and the v2 lexicon entries for
  // "can't"/"won't"/"cannot" plus the "doesn't work" regex would never fire
  // on realistic input.
  const lowerText = text.toLowerCase().replace(/’/g, "'")
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
  // v2 additions (eye-test Pattern B). `keeps` alone over-triggers — we only
  // catch the `keeps <V-ing>` complaint pattern from titles like
  // "Keeps Opening up the Configuration Page".
  if (/\bdoes\s+not\s+work\b/.test(lowerText)) negativeCount++
  if (/\bkeeps\s+(?:prompting|opening|asking|showing|failing|crashing|happening|popping)\b/.test(lowerText)) negativeCount++

  const keyword_presence = calculateKeywordPresence(text)

  const total = positiveCount + negativeCount
  if (total === 0) return { sentiment: "neutral", score: 0, keyword_presence }

  const score = (positiveCount - negativeCount) / total
  if (score > 0.2) {
    return { sentiment: "positive", score: Math.min(score, 0.99), keyword_presence }
  }
  if (score < -0.2) {
    return { sentiment: "negative", score: Math.max(score, -0.99), keyword_presence }
  }
  return { sentiment: "neutral", score, keyword_presence }
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
    { phrase: "issue", weight: 1, wholeWord: true },
    { phrase: "fails", weight: 2, wholeWord: true },
    { phrase: "unable to", weight: 2 },
    { phrase: "can't", weight: 1, wholeWord: true },
    { phrase: "cannot", weight: 1, wholeWord: true },
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
    { phrase: "support for", weight: 2 },
    { phrase: "when will", weight: 1 },
  ],
  documentation: [
    { phrase: "docs", weight: 2, wholeWord: true },
    { phrase: "documentation", weight: 3, wholeWord: true },
    { phrase: "readme", weight: 2, wholeWord: true },
    { phrase: "tutorial", weight: 2, wholeWord: true },
    { phrase: "guide", weight: 2, wholeWord: true },
    { phrase: "example", weight: 1, wholeWord: true },
    { phrase: "unclear", weight: 1, wholeWord: true },
    { phrase: "review", weight: 2, wholeWord: true },
    { phrase: "hands-on", weight: 2 },
    { phrase: "walkthrough", weight: 2, wholeWord: true },
    { phrase: "how to", weight: 1 },
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
    { phrase: "open-source llms", weight: 3 },
    { phrase: "open source llms", weight: 3 },
    { phrase: "github auth", weight: 3 },
    { phrase: "integrate", weight: 2, wholeWord: true },
    { phrase: "vs code", weight: 2 },
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
    { phrase: "billing", weight: 2, wholeWord: true },
    // `plan` alone (v2) was too noisy: it matched "I plan to", "system
    // plan", "execution plan" — pulling model-quality / planning posts
    // into Pricing on a single weight-1 hit. Replaced with multi-word
    // tier phrases that are unambiguously about paid plans.
    { phrase: "free plan", weight: 3 },
    { phrase: "pro plan", weight: 3 },
    { phrase: "team plan", weight: 3 },
    { phrase: "paid plan", weight: 3 },
    { phrase: "enterprise plan", weight: 3 },
    { phrase: "monthly fee", weight: 3 },
    { phrase: "per token", weight: 2 },
    { phrase: "per month", weight: 2 },
  ],
  "model-quality": [
    { phrase: "hallucination", weight: 3, wholeWord: true },
    { phrase: "hallucinated", weight: 3, wholeWord: true },
    { phrase: "hallucinates", weight: 3, wholeWord: true },
    { phrase: "hallucinate", weight: 3, wholeWord: true },
    { phrase: "model quality", weight: 4 },
    { phrase: "instruction following", weight: 4 },
    { phrase: "ignores instructions", weight: 4 },
    { phrase: "output quality", weight: 4 },
    { phrase: "wrong answer", weight: 3 },
    { phrase: "incorrect output", weight: 3 },
    { phrase: "system prompt", weight: 2 },
    { phrase: "distracted", weight: 2, wholeWord: true },
    { phrase: "off-topic", weight: 2 },
    { phrase: "off topic", weight: 2 },
    { phrase: "context window", weight: 2 },
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

// Heuristic top-level "topic" classifier. Returns a slug from the
// `categories` SQL table (bug, feature-request, performance, ux-ui, …).
// In the UI this value is surfaced as "Topic" — deliberately disjoint
// from the LLM `category` enum produced by lib/classification/pipeline.ts
// (surfaced as "LLM category"). The function name and `categories`
// parameter are kept for legacy reasons; the user-facing noun is "Topic".
// See docs/ARCHITECTURE.md §6.0 — Glossary.
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

  // Threshold stays at 2: v2 expands phrase lists and reweights strong
  // signals (e.g. `github auth` weight 3, `open-source llms` weight 3,
  // `hands-on`+`review` sum to 4) so that eye-test rows now classify
  // without needing the floor to drop. Lowering to 1 let single weight-1
  // hits (`roadmap`, `example`, `connect`) wrongly pull posts out of Other
  // on thin evidence — a regression the pre-merge review caught.
  if (top.score < 2) {
    return categories.find((c) => c.slug === "other")?.id
  }

  const category = categories.find((c) => c.slug === top.slug)
  if (category) return category.id

  return categories.find((c) => c.slug === "other")?.id
}

// v2 authority table (eye-test Pattern A). Applied multiplicatively after the
// sentiment boost and before the 1-10 clamp. First-party bug-report channels
// outrank announcement/news channels at identical engagement. See
// docs/SCORING.md §3. Unknown/undefined slugs fall back to 1.0× so the
// function stays back-compat with any call site that hasn't been updated.
const SOURCE_AUTHORITY: Record<string, number> = {
  github: 1.8,
  "github-discussions": 1.4,
  stackoverflow: 1.0,
  "openai-community": 1.0,
  reddit: 0.7,
  hackernews: 0.7,
}

export function calculateImpactScore(
  upvotes: number,
  comments: number,
  sentiment: string,
  sourceSlug?: string
): number {
  const engagementScore = Math.min(
    Math.log10((upvotes || 1) + (comments || 1) * 2) * 2,
    8
  )
  const sentimentBoost = sentiment === "negative" ? 1.5 : 1
  const authority = sourceSlug ? SOURCE_AUTHORITY[sourceSlug] ?? 1.0 : 1.0
  return Math.min(Math.round(engagementScore * sentimentBoost * authority), 10)
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
