export type RelevanceDecision = {
  passed: boolean
  relevanceReason: string | null
  decision: string
}

const SCOPED_INCLUDE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bopenai\s+codex\b/i, reason: "matched:openai codex" },
  { pattern: /\bchatgpt\s+codex\b/i, reason: "matched:chatgpt codex" },
  { pattern: /\bcodex\s+agent\b/i, reason: "matched:codex agent" },
  { pattern: /\bcodex\s+vscode\b|\bvscode\s+codex\b/i, reason: "matched:codex vscode" },
  { pattern: /\bcodex\s+cli\b/i, reason: "matched:codex cli" },
  { pattern: /\bopenai\/codex\b/i, reason: "matched:openai/codex repo alias" },
  {
    pattern: /\bcodex\b.{0,30}\b(openai|chatgpt)\b|\b(openai|chatgpt)\b.{0,30}\bcodex\b/i,
    reason: "matched:codex with openai/chatgpt context",
  },
  {
    pattern: /\bcodex\b.{0,30}\b(terminal|cli tool|command line)\b|\b(terminal|cli tool|command line)\b.{0,30}\bcodex\b/i,
    reason: "matched:codex cli/terminal alias",
  },
]

// Ordered specific-first so the decision reason is as informative as
// possible for debuggability: a post matching both "Microsoft Copilot for
// Sales" and the generic "Microsoft Copilot" catch-all is reported as the
// SKU-specific match.
const EXCLUSION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bcopilot\s+for\s+sales\b/i, reason: "excluded:copilot for sales" },
  {
    pattern: /\bcopilot\s+for\s+(microsoft\s+365|finance|service|security)\b/i,
    reason: "excluded:copilot for business suite",
  },
  { pattern: /\bpower\s+platform\s+copilot\b/i, reason: "excluded:power platform copilot" },
  { pattern: /\bmicrosoft\s+copilot\b/i, reason: "excluded:microsoft copilot" },
]

export function evaluateCodexRelevance(text: string): RelevanceDecision {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return { passed: false, relevanceReason: null, decision: "empty-input" }
  }

  // Include-first: a scoped Codex mention wins over any exclusion so that
  // legitimate posts which co-mention a Copilot SKU are still ingested.
  // This matches the exclusion-with-include-override semantics in
  // scripts/005_add_relevance_reason_and_cleanup.sql.
  for (const candidate of SCOPED_INCLUDE_PATTERNS) {
    if (candidate.pattern.test(normalized)) {
      return {
        passed: true,
        relevanceReason: candidate.reason,
        decision: candidate.reason,
      }
    }
  }

  for (const candidate of EXCLUSION_PATTERNS) {
    if (candidate.pattern.test(normalized)) {
      return {
        passed: false,
        relevanceReason: null,
        decision: candidate.reason,
      }
    }
  }

  return { passed: false, relevanceReason: null, decision: "no-match" }
}

// Canonical scope list used by Hacker News's required+optional query split.
// Reddit no longer derives from this list (see REDDIT_SCOPED_QUERY_TERMS
// below) because Reddit's per-subreddit topical filter + the strict
// evaluator above lets us trade upstream precision for recall.
export const CODEX_CORE_PHRASES: readonly string[] = [
  "openai codex",
  "chatgpt codex",
  "codex agent",
  "codex vscode",
  "codex cli",
  "openai/codex",
  "codex terminal",
]

// Reddit query: a single broad term. The subreddits in
// lib/scrapers/providers/reddit.ts already provide topical scoping
// (r/OpenaiCodex, r/OpenAI, r/ChatGPTCoding) and evaluateCodexRelevance
// above is the precision filter. Adding scoped phrases here would be
// redundant within the limit=25 OR-clause budget — every post matching
// "openai codex" already matches "codex".
export const REDDIT_SCOPED_QUERY_TERMS: readonly string[] = ["codex"]

export const HACKERNEWS_QUERY_PARAMS = {
  query: "openai codex",
  optional: CODEX_CORE_PHRASES.filter((phrase) => phrase !== "openai codex"),
}
