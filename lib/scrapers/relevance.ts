export type RelevanceMatch = {
  passed: boolean
  relevanceReason: string | null
}

const SCOPED_INCLUDE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bopenai\s+codex\b/i, reason: "matched:openai codex" },
  { pattern: /\bchatgpt\s+codex\b/i, reason: "matched:chatgpt codex" },
  { pattern: /\bcodex\s+cli\b/i, reason: "matched:codex cli" },
  { pattern: /\bopenai\/codex\b/i, reason: "matched:openai\/codex repo alias" },
  { pattern: /\bcodex\b.{0,30}\b(openai|chatgpt)\b|\b(openai|chatgpt)\b.{0,30}\bcodex\b/i, reason: "matched:codex with openai/chatgpt context" },
  { pattern: /\bcodex\b.{0,30}\b(terminal|cli tool|command line)\b|\b(terminal|cli tool|command line)\b.{0,30}\bcodex\b/i, reason: "matched:codex cli/terminal alias" },
]

const EXCLUSION_PATTERNS = [
  /\bmicrosoft\s+copilot\b/i,
  /\bcopilot\s+for\s+sales\b/i,
  /\bcopilot\s+for\s+(microsoft\s+365|finance|service|security)\b/i,
  /\bpower\s+platform\s+copilot\b/i,
]

export const RELEVANCE_EXCLUSION_REASONS = EXCLUSION_PATTERNS.map((pattern) => pattern.source)

export function evaluateCodexRelevance(text: string): RelevanceMatch {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return { passed: false, relevanceReason: null }

  if (EXCLUSION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { passed: false, relevanceReason: null }
  }

  for (const candidate of SCOPED_INCLUDE_PATTERNS) {
    if (candidate.pattern.test(normalized)) {
      return { passed: true, relevanceReason: candidate.reason }
    }
  }

  return { passed: false, relevanceReason: null }
}

export const REDDIT_SCOPED_QUERY_TERMS = [
  '"openai codex"',
  '"chatgpt codex"',
  '"codex cli"',
  '"openai/codex"',
  '"codex terminal"',
]
