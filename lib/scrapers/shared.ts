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
    { phrase: "error", weight: 2, wholeWord: true },
    { phrase: "errored", weight: 3, wholeWord: true },
    { phrase: "panic", weight: 4, wholeWord: true },
    { phrase: "segfault", weight: 4 },
    { phrase: "traceback", weight: 4 },
    { phrase: "stack trace", weight: 4 },
    { phrase: "exception", weight: 3, wholeWord: true },
    { phrase: "typeerror", weight: 4 },
    { phrase: "attributeerror", weight: 4 },
    { phrase: "syntaxerror", weight: 4 },
    { phrase: "unicodeencodeerror", weight: 4 },
    { phrase: "enoent", weight: 4 },
    { phrase: "eacces", weight: 4 },
    { phrase: "epipe", weight: 4 },
    { phrase: "permission denied", weight: 3 },
    { phrase: "crash", weight: 3 },
    { phrase: "crashed", weight: 3 },
    { phrase: "crashes", weight: 3 },
    { phrase: "broken", weight: 2, wholeWord: true },
    { phrase: "not working", weight: 3 },
    { phrase: "doesn't work", weight: 3 },
    { phrase: "doesn’t work", weight: 3 },
    { phrase: "does not work", weight: 3 },
    { phrase: "regress", weight: 3, wholeWord: true },
    { phrase: "regression", weight: 3, wholeWord: true },
    { phrase: "regressed", weight: 3, wholeWord: true },
    { phrase: "fails to", weight: 2 },
    { phrase: "failed to", weight: 2 },
    { phrase: "failed with", weight: 2 },
    { phrase: "unable to", weight: 2 },
    { phrase: "timeout waiting for child process to exit", weight: 4 },
    { phrase: "diff edit mismatch", weight: 4 },
    { phrase: "diff edit failed", weight: 4 },
  ],
  performance: [
    { phrase: "memory leak", weight: 4 },
    { phrase: "high cpu", weight: 4 },
    { phrase: "cpu load", weight: 3 },
    { phrase: "slow", weight: 3 },
    { phrase: "sluggish", weight: 3 },
    { phrase: "latency", weight: 3 },
    { phrase: "lag", weight: 3 },
    { phrase: "hangs", weight: 3 },
    { phrase: "hanging", weight: 3 },
    { phrase: "hang indefinitely", weight: 4 },
    { phrase: "freeze", weight: 3 },
    { phrase: "frozen", weight: 3 },
    { phrase: "freezing", weight: 3 },
    { phrase: "unresponsive", weight: 3 },
    { phrase: "timed out", weight: 2 },
    { phrase: "timeout", weight: 2, wholeWord: true },
    { phrase: "stuck on loading", weight: 4 },
    { phrase: "loading forever", weight: 4 },
    { phrase: "takes forever", weight: 4 },
    { phrase: "painfully slow", weight: 4 },
    { phrase: "resume picker slowed", weight: 4 },
  ],
  "feature-request": [
    { phrase: "what feature would you like to see", weight: 4 },
    { phrase: "feature request", weight: 4 },
    { phrase: "please add", weight: 3 },
    { phrase: "can you add", weight: 3 },
    { phrase: "please bring back", weight: 3 },
    { phrase: "please consider", weight: 2 },
    { phrase: "support for", weight: 2 },
    { phrase: "allow disabling", weight: 3 },
    { phrase: "option to", weight: 2 },
    { phrase: "would like to see", weight: 3 },
    { phrase: "i would like", weight: 2 },
    { phrase: "it would be great", weight: 2 },
    { phrase: "enhancement", weight: 2, wholeWord: true },
    { phrase: "bring back", weight: 2 },
  ],
  documentation: [
    { phrase: "documentation", weight: 4, wholeWord: true },
    { phrase: "docs", weight: 3, wholeWord: true },
    { phrase: "readme", weight: 3, wholeWord: true },
    { phrase: "troubleshooting guide", weight: 3 },
    { phrase: "install documentation", weight: 3 },
    { phrase: "setup documentation", weight: 3 },
    { phrase: "docs:", weight: 2 },
    { phrase: "missing docs", weight: 3 },
    { phrase: "outdated docs", weight: 3 },
    { phrase: "unclear docs", weight: 3 },
    { phrase: "not documented", weight: 3 },
    { phrase: "hands-on", weight: 2 },
    { phrase: "hands-on review", weight: 2 },
    { phrase: "guide", weight: 2, wholeWord: true },
    { phrase: "walkthrough", weight: 2, wholeWord: true },
    { phrase: "how to", weight: 1 },
  ],
  "ux-ui": [
    { phrase: "approval prompt", weight: 4 },
    { phrase: "diff view", weight: 4 },
    { phrase: "review pane", weight: 4 },
    { phrase: "loading icon", weight: 4 },
    { phrase: "flicker", weight: 4 },
    { phrase: "flickering", weight: 4 },
    { phrase: "sidebar", weight: 2 },
    { phrase: "picker", weight: 3 },
    { phrase: "tui", weight: 2, wholeWord: true },
    { phrase: "ui", weight: 2, wholeWord: true },
    { phrase: "ux", weight: 2, wholeWord: true },
    { phrase: "user interface", weight: 3 },
    { phrase: "layout", weight: 2, wholeWord: true },
    { phrase: "button", weight: 2, wholeWord: true },
    { phrase: "rendered", weight: 2 },
    { phrase: "rendering", weight: 2 },
    { phrase: "display no", weight: 2 },
    { phrase: "does not show", weight: 2 },
    { phrase: "not rendered", weight: 3 },
    { phrase: "misleading", weight: 2 },
    { phrase: "confusing", weight: 2, wholeWord: true },
    { phrase: "auto-accept", weight: 4 },
    { phrase: "auto accept", weight: 4 },
    { phrase: "accept diffs", weight: 4 },
    { phrase: "review loop", weight: 3 },
    { phrase: "diffs are shown", weight: 3 },
    { phrase: "waiting for review", weight: 3 },
  ],
  integration: [
    { phrase: "mcp server", weight: 4 },
    { phrase: "mcp tool", weight: 4 },
    { phrase: "mcp", weight: 3, wholeWord: true },
    { phrase: "model context protocol", weight: 4 },
    { phrase: "tool invocation", weight: 4 },
    { phrase: "tool call", weight: 3 },
    { phrase: "function call output", weight: 4 },
    { phrase: "function call with call_id", weight: 4 },
    { phrase: "plugin", weight: 3, wholeWord: true },
    { phrase: "extension", weight: 3, wholeWord: true },
    { phrase: "vscode", weight: 3, wholeWord: true },
    { phrase: "vs code", weight: 3 },
    { phrase: "jetbrains", weight: 3, wholeWord: true },
    { phrase: "intellij", weight: 3 },
    { phrase: "phpstorm", weight: 3 },
    { phrase: "devcontainer", weight: 3 },
    { phrase: "dev container", weight: 3 },
    { phrase: "codespaces", weight: 3 },
    { phrase: "wsl", weight: 3, wholeWord: true },
    { phrase: "remote ssh", weight: 4 },
    { phrase: "remote development", weight: 4 },
    { phrase: "github auth", weight: 4 },
    { phrase: "oauth callback", weight: 4 },
    { phrase: "open-source llms", weight: 3 },
    { phrase: "open source llms", weight: 3 },
    { phrase: "openai-compatible provider", weight: 4 },
    { phrase: "replace_in_file", weight: 4 },
    { phrase: "write_to_file", weight: 4 },
    { phrase: "apply_patch", weight: 4 },
    { phrase: "diff edit mismatch", weight: 3 },
    { phrase: "diff edit failed", weight: 3 },
    { phrase: "file writing tool", weight: 4 },
    { phrase: "file editing tool", weight: 4 },
    { phrase: "no file changes", weight: 4 },
    { phrase: "no actual changes", weight: 4 },
    { phrase: "cannot make changes", weight: 4 },
    { phrase: "fails to edit", weight: 4 },
    { phrase: "failed to edit", weight: 4 },
    { phrase: "says code was modified", weight: 4 },
  ],
  api: [
    { phrase: "responses api", weight: 4 },
    { phrase: "chat completions", weight: 4 },
    { phrase: "openai-compatible /v1 endpoint", weight: 4 },
    { phrase: "openai-compatible endpoint", weight: 4 },
    { phrase: "api key", weight: 4 },
    { phrase: "base url", weight: 3 },
    { phrase: "base_url", weight: 3 },
    { phrase: "endpoint", weight: 3, wholeWord: true },
    { phrase: "http 500", weight: 4 },
    { phrase: "http 404", weight: 4 },
    { phrase: "http 403", weight: 4 },
    { phrase: "http 401", weight: 4 },
    { phrase: "http 429", weight: 4 },
    { phrase: "status code", weight: 3 },
    { phrase: "request timed out", weight: 3 },
    { phrase: "request timeout", weight: 3 },
    { phrase: "invalid payload", weight: 3 },
    { phrase: "headers not defined", weight: 4 },
    { phrase: "streaming", weight: 3, wholeWord: true },
    { phrase: "unauthorized", weight: 3, wholeWord: true },
    { phrase: "forbidden", weight: 3, wholeWord: true },
    { phrase: "api", weight: 1, wholeWord: true },
    { phrase: "429", weight: 2, wholeWord: true },
    { phrase: "500", weight: 2, wholeWord: true },
    { phrase: "404", weight: 2, wholeWord: true },
    { phrase: "403", weight: 2, wholeWord: true },
    { phrase: "401", weight: 2, wholeWord: true },
  ],
  pricing: [
    { phrase: "quota exceeded", weight: 4 },
    { phrase: "usage limit", weight: 4 },
    { phrase: "remaining usage", weight: 4 },
    { phrase: "purchase more credits", weight: 4 },
    { phrase: "more credits", weight: 3 },
    { phrase: "out of credits", weight: 4 },
    { phrase: "billing details", weight: 4 },
    { phrase: "billing", weight: 3, wholeWord: true },
    { phrase: "pricing", weight: 4, wholeWord: true },
    { phrase: "subscription", weight: 3, wholeWord: true },
    { phrase: "free tier", weight: 3 },
    { phrase: "free plan", weight: 3 },
    { phrase: "pro plan", weight: 3 },
    { phrase: "team plan", weight: 3 },
    { phrase: "enterprise plan", weight: 3 },
    { phrase: "credits", weight: 3, wholeWord: true },
    { phrase: "quota", weight: 3, wholeWord: true },
    { phrase: "daily limit", weight: 3 },
    { phrase: "weekly usage", weight: 3 },
    { phrase: "5-hour limit", weight: 4 },
    { phrase: "rate limit usage remaining", weight: 4 },
    { phrase: "free api tier", weight: 4 },
    { phrase: "api tier", weight: 3 },
    { phrase: "trial token rate limit exceeded", weight: 4 },
    { phrase: "rate limit", weight: 2 },
    { phrase: "rate-limits", weight: 2 },
    { phrase: "monthly fee", weight: 3 },
    { phrase: "per token", weight: 2 },
    { phrase: "per month", weight: 2 },
    { phrase: "expensive", weight: 3, wholeWord: true },
    { phrase: "cost", weight: 2, wholeWord: true },
  ],
  "model-quality": [
    { phrase: "hallucination", weight: 4 },
    { phrase: "hallucinated", weight: 4 },
    { phrase: "hallucinates", weight: 4 },
    { phrase: "hallucinate", weight: 4 },
    { phrase: "made up", weight: 4 },
    { phrase: "fabricated", weight: 4 },
    { phrase: "invented", weight: 4 },
    { phrase: "nonexistent", weight: 4 },
    { phrase: "wrong answer", weight: 3 },
    { phrase: "wrong context", weight: 4 },
    { phrase: "wrong file", weight: 3 },
    { phrase: "loses task intent", weight: 4 },
    { phrase: "loses context", weight: 4 },
    { phrase: "context mismatch", weight: 4 },
    { phrase: "context window", weight: 3 },
    { phrase: "context length", weight: 3 },
    { phrase: "context lenght", weight: 3 },
    { phrase: "prompt too long", weight: 3 },
    { phrase: "context-window overflow", weight: 4 },
    { phrase: "ignores instructions", weight: 4 },
    { phrase: "doesn't follow instructions", weight: 4 },
    { phrase: "doesn’t follow instructions", weight: 4 },
    { phrase: "instruction following", weight: 3 },
    { phrase: "system prompt", weight: 3 },
    { phrase: "repeats the same", weight: 4 },
    { phrase: "same message again and again", weight: 4 },
    { phrase: "same step multiple times", weight: 4 },
    { phrase: "looping on the same", weight: 4 },
    { phrase: "keeps looping", weight: 4 },
    { phrase: "looping on same message", weight: 5 },
    { phrase: "same message", weight: 3 },
    { phrase: "again and again", weight: 3 },
    { phrase: "loops back", weight: 4 },
    { phrase: "loop over the same step", weight: 5 },
    { phrase: "enters a loop", weight: 4 },
    { phrase: "infinite reasoning loop", weight: 4 },
    { phrase: "repetitive thinking", weight: 4 },
    { phrase: "starts over", weight: 3 },
    { phrase: "goes off the rails", weight: 4 },
    { phrase: "task drift", weight: 4 },
    { phrase: "verbose", weight: 2, wholeWord: true },
    { phrase: "lazy", weight: 2, wholeWord: true },
    { phrase: "distracted", weight: 3, wholeWord: true },
    { phrase: "off topic", weight: 3 },
    { phrase: "off-topic", weight: 3 },
  ],
  security: [
    { phrase: "prompt injection", weight: 4 },
    { phrase: "sandbox escape", weight: 4 },
    { phrase: "read whole filesystem", weight: 4 },
    { phrase: "whole filesystem", weight: 4 },
    { phrase: "path traversal", weight: 4 },
    { phrase: "rce", weight: 4, wholeWord: true },
    { phrase: "remote code execution", weight: 4 },
    { phrase: "secret", weight: 3, wholeWord: true },
    { phrase: "credential", weight: 3 },
    { phrase: "api key leak", weight: 4 },
    { phrase: "pii", weight: 4, wholeWord: true },
    { phrase: "privacy", weight: 3, wholeWord: true },
    { phrase: "security", weight: 3, wholeWord: true },
    { phrase: "vulnerability", weight: 4, wholeWord: true },
    { phrase: "exfiltrat", weight: 4 },
    { phrase: "leaked", weight: 3 },
    { phrase: "leak", weight: 2, wholeWord: true },
    { phrase: "exposed", weight: 3, wholeWord: true },
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

  // Threshold stays at 2: stronger phrase lists and reweights mean
  // high-signal cues clear the floor on their own (e.g. `mcp server` weight 4,
  // `quota exceeded` weight 4, `hands-on`+`hands-on review` sum to 4) without
  // lowering the baseline. Lowering to 1 let single weak hits wrongly pull
  // posts out of Other on thin evidence — a regression the pre-merge review caught.
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
