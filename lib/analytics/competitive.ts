import { COMPETITOR_KEYWORDS } from "../scrapers/shared.ts"

type Sentiment = "positive" | "negative" | "neutral"

type MentionSentiment = {
  score: number
  confidence: number
  sentiment: Sentiment
}

export interface CompetitiveIssueInput {
  id: string
  title: string
  content: string | null
  url: string | null
  sentiment: Sentiment | null
  impact_score: number | null
  published_at: string | null
}

export interface CompetitiveMention {
  competitor: string
  totalMentions: number
  rawMentions: number
  scoredMentions: number
  coverage: number
  avgConfidence: number
  positive: number
  negative: number
  neutral: number
  netSentiment: number // -1..1, weighted by per-issue mention sentiment
  topIssues: Array<{
    id: string
    title: string
    url: string | null
    sentiment: Sentiment
    confidence: number
    impact_score: number
  }>
}

const PRETTY_NAME: Record<string, string> = {
  "claude-code": "Claude Code",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  windsurf: "Windsurf",
  gemini: "Gemini Code",
  cody: "Sourcegraph Cody",
}

const POSITIVE_WORDS = new Set([
  "good", "great", "awesome", "excellent", "fast", "faster", "helpful", "love", "solid",
  "fine", "works", "working", "better", "best", "improved", "reliable",
])

const NEGATIVE_WORDS = new Set([
  "bad", "awful", "terrible", "slow", "slower", "broken", "buggy", "hate", "worse", "worst",
  "unusable", "frustrating", "fails", "failing", "error", "errors",
])

const NEGATORS = new Set(["not", "never", "no", "hardly", "scarcely", "without", "n't"])

function classifySentiment(score: number): Sentiment {
  if (score > 0.25) return "positive"
  if (score < -0.25) return "negative"
  return "neutral"
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getSentenceWindow(text: string, mentionIndex: number): string {
  const leftBound = Math.max(
    text.lastIndexOf(".", mentionIndex),
    text.lastIndexOf("!", mentionIndex),
    text.lastIndexOf("?", mentionIndex),
    text.lastIndexOf("\n", mentionIndex)
  )

  const rightCandidates = [
    text.indexOf(".", mentionIndex),
    text.indexOf("!", mentionIndex),
    text.indexOf("?", mentionIndex),
    text.indexOf("\n", mentionIndex),
  ].filter((i) => i !== -1)

  const rightBound = rightCandidates.length > 0 ? Math.min(...rightCandidates) : text.length

  const windowStart = Math.max(0, leftBound + 1 - 120)
  const windowEnd = Math.min(text.length, rightBound + 120)

  return text.slice(windowStart, windowEnd)
}

function findMentionIndexes(text: string, phrase: string): number[] {
  const clean = phrase.trim().toLowerCase()
  if (!clean) return []

  const indices: number[] = []
  let start = 0

  while (start < text.length) {
    const idx = text.indexOf(clean, start)
    if (idx === -1) break

    const leftChar = idx === 0 ? " " : text[idx - 1]
    const rightChar = idx + clean.length >= text.length ? " " : text[idx + clean.length]
    const leftOk = !/[a-z0-9]/.test(leftChar)
    const rightOk = !/[a-z0-9]/.test(rightChar)

    if (leftOk && rightOk) {
      indices.push(idx)
    }

    start = idx + clean.length
  }

  return indices
}


function getDetectionPhrases(competitorKey: string, phrases: string[]): string[] {
  const pretty = PRETTY_NAME[competitorKey] ?? competitorKey
  const defaults = [
    competitorKey.replace(/-/g, " "),
    pretty.toLowerCase(),
    pretty.toLowerCase().replace(/\scode$/, ""),
  ]

  return Array.from(new Set([...phrases, ...defaults].map((p) => p.trim()).filter(Boolean)))
}

export function scoreMentionSentiment(windowText: string): MentionSentiment {
  const lower = windowText.toLowerCase()
  const tokens = lower.match(/[a-z']+/g) ?? []

  let score = 0
  let evidenceHits = 0

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    let tokenScore = 0

    if (POSITIVE_WORDS.has(token)) tokenScore = 1
    if (NEGATIVE_WORDS.has(token)) tokenScore = -1
    if (tokenScore === 0) continue

    const prev3 = tokens.slice(Math.max(0, i - 3), i)
    const hasNegation = prev3.some((prev) => NEGATORS.has(prev))
    if (hasNegation) tokenScore *= -1

    score += tokenScore
    evidenceHits++
  }

  if (/better\s+than\s+codex/.test(lower)) {
    score += 1.5
    evidenceHits++
  }
  if (/worse\s+than\s+codex/.test(lower)) {
    score -= 1.5
    evidenceHits++
  }

  if (evidenceHits === 0) {
    return { score: 0, confidence: 0, sentiment: "neutral" }
  }

  const normalized = clamp(score / Math.max(1, evidenceHits), -1, 1)
  const confidence = clamp(0.25 + evidenceHits * 0.2 + Math.abs(normalized) * 0.35, 0, 1)
  const sentiment = classifySentiment(normalized)

  return {
    score: Number(normalized.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    sentiment,
  }
}

export function aggregateCompetitorSentimentForIssue(
  issueText: string,
  competitorPhrases: string[]
): {
  mentionCount: number
  scoredMentions: number
  score: number
  confidence: number
  sentiment: Sentiment
} | null {
  const lower = issueText.toLowerCase()
  const mentionIndexes = competitorPhrases.flatMap((phrase) => findMentionIndexes(lower, phrase))

  if (mentionIndexes.length === 0) return null

  const mentionScores = mentionIndexes.map((idx) => scoreMentionSentiment(getSentenceWindow(issueText, idx)))
  const scoredMentions = mentionScores.filter((m) => m.confidence > 0).length

  const avgScore = mentionScores.reduce((sum, m) => sum + m.score, 0) / mentionScores.length
  const avgConfidence = mentionScores.reduce((sum, m) => sum + m.confidence, 0) / mentionScores.length

  return {
    mentionCount: mentionIndexes.length,
    scoredMentions,
    score: Number(avgScore.toFixed(3)),
    confidence: Number(avgConfidence.toFixed(3)),
    sentiment: classifySentiment(avgScore),
  }
}

export function computeCompetitiveMentions(
  issues: CompetitiveIssueInput[]
): CompetitiveMention[] {
  const buckets = new Map<
    string,
    {
      total: number
      rawMentions: number
      scoredMentions: number
      confidenceSum: number
      positive: number
      negative: number
      neutral: number
      sentimentSum: number
      samples: CompetitiveMention["topIssues"]
    }
  >()

  for (const issue of issues) {
    const issueText = `${issue.title || ""} ${issue.content || ""}`.trim()
    if (!issueText) continue

    for (const [competitor, phrases] of Object.entries(COMPETITOR_KEYWORDS)) {
      const detectionPhrases = getDetectionPhrases(competitor, phrases)
      const issueAggregate = aggregateCompetitorSentimentForIssue(issueText, detectionPhrases)
      if (!issueAggregate) continue

      const bucket = buckets.get(competitor) ?? {
        total: 0,
        rawMentions: 0,
        scoredMentions: 0,
        confidenceSum: 0,
        positive: 0,
        negative: 0,
        neutral: 0,
        sentimentSum: 0,
        samples: [],
      }

      bucket.total++
      bucket.rawMentions += issueAggregate.mentionCount
      bucket.scoredMentions += issueAggregate.scoredMentions
      bucket.confidenceSum += issueAggregate.confidence
      bucket.sentimentSum += issueAggregate.score

      if (issueAggregate.sentiment === "positive") bucket.positive++
      else if (issueAggregate.sentiment === "negative") bucket.negative++
      else bucket.neutral++

      bucket.samples.push({
        id: issue.id,
        title: issue.title,
        url: issue.url,
        sentiment: issueAggregate.sentiment,
        confidence: issueAggregate.confidence,
        impact_score: issue.impact_score || 0,
      })

      buckets.set(competitor, bucket)
    }
  }

  return Array.from(buckets.entries())
    .map(([competitor, b]) => ({
      competitor: PRETTY_NAME[competitor] || competitor,
      totalMentions: b.total,
      rawMentions: b.rawMentions,
      scoredMentions: b.scoredMentions,
      coverage: Number((b.scoredMentions / Math.max(1, b.rawMentions)).toFixed(2)),
      avgConfidence: Number((b.confidenceSum / Math.max(1, b.total)).toFixed(2)),
      positive: b.positive,
      negative: b.negative,
      neutral: b.neutral,
      netSentiment: Number((b.sentimentSum / Math.max(1, b.total)).toFixed(2)),
      topIssues: b.samples.sort((x, y) => y.impact_score - x.impact_score).slice(0, 3),
    }))
    .sort((a, b) => b.totalMentions - a.totalMentions)
}
