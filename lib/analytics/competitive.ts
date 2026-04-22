import { COMPETITOR_KEYWORDS, COMPETITOR_DISPLAY_NAMES } from "./competitors.ts"
import { NEGATIVE_WORDS, NEGATORS, POSITIVE_WORDS } from "./sentiment-lexicon.ts"

type Sentiment = "positive" | "negative" | "neutral"

type MentionSentiment = {
  score: number
  confidence: number
  sentiment: Sentiment | null
  valenceTokens: number
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
    sentiment: Sentiment | null
    confidence: number
    impact_score: number
  }>
}

export interface CompetitiveMentionsOptions {
  // Brand that competitor sentiment is expressed *relative to*. Used for
  // comparative phrasing detection ("X is better than <anchor>"). Defaults to
  // "codex" to match the product this dashboard is built around; parameterize
  // to reuse the module for another brand.
  anchorBrand?: string
}

const DEFAULT_OPTIONS: Required<CompetitiveMentionsOptions> = {
  anchorBrand: "codex",
}

const POSITIVE_THRESHOLD = 0.25
const NEGATIVE_THRESHOLD = -0.25
const NEGATION_LOOKBACK_TOKENS = 3
const COMPARATIVE_BOOST = 1.0

// Hard cap on how far a mention window can stretch when no sentence boundary
// is found nearby. Without this, an unpunctuated social-media blob ("cursor
// ide is great love it amazing") is treated as a single sentence and
// effectively scored at the full-post level — the exact regime the mention-
// window design was meant to replace.
const MAX_WINDOW_CHARS = 280

const SENTENCE_BOUNDARIES = [".", "!", "?", "\n"] as const

function classifySentiment(score: number): Sentiment {
  if (score > POSITIVE_THRESHOLD) return "positive"
  if (score < NEGATIVE_THRESHOLD) return "negative"
  return "neutral"
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Sentence window bounded by sentence-ending punctuation OR by a hard
// character budget around the mention — whichever is closer. The budget is
// what makes unpunctuated blobs safe: at most MAX_WINDOW_CHARS characters on
// each side of the mention are in scope, so a 5k-character rant without
// periods no longer leaks sentiment across paragraphs.
function getSentenceWindow(text: string, mentionIndex: number): string {
  const leftReachLimit = Math.max(-1, mentionIndex - MAX_WINDOW_CHARS - 1)
  const rightReachLimit = Math.min(text.length, mentionIndex + MAX_WINDOW_CHARS)

  let leftBound = leftReachLimit
  for (const char of SENTENCE_BOUNDARIES) {
    const idx = text.lastIndexOf(char, mentionIndex - 1)
    if (idx > leftBound) leftBound = idx
  }

  let rightBound = rightReachLimit
  for (const char of SENTENCE_BOUNDARIES) {
    const idx = text.indexOf(char, mentionIndex)
    if (idx !== -1 && idx < rightBound) rightBound = idx
  }

  return text.slice(leftBound + 1, rightBound)
}

// Anchor-brand regex factory. Constructing RegExp per mention-per-issue-per-
// competitor was measurable at scale; caching keyed by anchor lets the common
// case (one anchor for the whole run) amortize to two lookups per window.
type AnchorRegexes = { better: RegExp; worse: RegExp }
const ANCHOR_REGEX_CACHE = new Map<string, AnchorRegexes>()

function getAnchorRegexes(anchorBrand: string): AnchorRegexes {
  const key = anchorBrand.toLowerCase()
  const cached = ANCHOR_REGEX_CACHE.get(key)
  if (cached) return cached
  const anchor = escapeRegExp(key)
  const built: AnchorRegexes = {
    better: new RegExp(`\\bbetter\\s+than\\s+${anchor}\\b`),
    worse: new RegExp(`\\bworse\\s+than\\s+${anchor}\\b`),
  }
  ANCHOR_REGEX_CACHE.set(key, built)
  return built
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
    // Word boundary: alphanumerics on either side would indicate we matched
    // inside a longer identifier (e.g. "cursor" inside "myCursorHelper").
    const leftOk = !/[a-z0-9]/.test(leftChar)
    const rightOk = !/[a-z0-9]/.test(rightChar)

    if (leftOk && rightOk) {
      indices.push(idx)
    }

    start = idx + clean.length
  }

  return indices
}

/**
 * Score sentiment for a single mention window.
 *
 * Confidence is defined as `evidence_density × polarity_agreement`, where
 * density saturates at three valence tokens and agreement is the absolute
 * value of the normalized score. A window with no valence tokens returns
 * `sentiment: null` so callers can distinguish "no signal" from "neutral
 * signal" — which matters for the API's topIssues contract.
 */
export function scoreMentionSentiment(
  windowText: string,
  options: CompetitiveMentionsOptions = {}
): MentionSentiment {
  const { anchorBrand } = { ...DEFAULT_OPTIONS, ...options }
  // Normalize U+2019 → ASCII apostrophe (see analyzeSentiment note) so the
  // tokenizer sees "can't"/"won't" on realistic web input.
  const lower = windowText.toLowerCase().replace(/’/g, "'")
  const tokens = lower.match(/[a-z']+/g) ?? []

  let score = 0
  let valenceTokens = 0

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    let tokenScore = 0

    if (POSITIVE_WORDS.has(token)) tokenScore = 1
    else if (NEGATIVE_WORDS.has(token)) tokenScore = -1
    if (tokenScore === 0) continue

    const lookback = tokens.slice(Math.max(0, i - NEGATION_LOOKBACK_TOKENS), i)
    if (lookback.some((prev) => NEGATORS.has(prev))) tokenScore *= -1

    score += tokenScore
    valenceTokens++
  }

  // Comparative phrasing against the anchor brand is a strong explicit signal.
  // We intentionally count it as one additional valence token rather than two
  // to avoid double-counting with the "better"/"worse" token already scored
  // above. Regexes are cached per anchor (see getAnchorRegexes).
  const anchorRegexes = getAnchorRegexes(anchorBrand)
  if (anchorRegexes.better.test(lower)) {
    score += COMPARATIVE_BOOST
    valenceTokens++
  }
  if (anchorRegexes.worse.test(lower)) {
    score -= COMPARATIVE_BOOST
    valenceTokens++
  }

  if (valenceTokens === 0) {
    return { score: 0, confidence: 0, sentiment: null, valenceTokens: 0 }
  }

  const normalized = clamp(score / valenceTokens, -1, 1)
  // Confidence = density × agreement. Both components are principled:
  //   density:   Math.min(1, valenceTokens / 3) — three valence tokens in a
  //              single sentence window saturates confidence.
  //   agreement: 0.5 + 0.5 × |normalized| — mixed-polarity windows (score ≈ 0)
  //              get half weight; clean one-sided signals get full weight.
  const density = Math.min(1, valenceTokens / 3)
  const agreement = 0.5 + 0.5 * Math.abs(normalized)
  const confidence = clamp(density * agreement, 0, 1)

  return {
    score: Number(normalized.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    sentiment: classifySentiment(normalized),
    valenceTokens,
  }
}

/**
 * Aggregate per-mention sentiment into a single per-issue signal for one
 * competitor. Returns null when the competitor isn't mentioned. Windows with
 * zero evidence still contribute to `mentionCount` (so we can report raw
 * mention volume) but do not contribute to `avgScore` or `avgConfidence`.
 *
 * When every window was evidence-free, the returned sentiment is `null` — we
 * deliberately do NOT fall back to the ingest-time `issue.sentiment`. Doing
 * so would re-introduce P0-4 through a side channel: a post broadly negative
 * about Codex that merely name-drops Cursor would inherit the post-level
 * negative sentiment and attribute it to Cursor even though no Cursor-
 * specific evidence exists. `null` lets the UI honestly render "no signal."
 */
export function aggregateCompetitorSentimentForIssue(
  issueText: string,
  competitorPhrases: string[],
  options: CompetitiveMentionsOptions = {},
): {
  mentionCount: number
  scoredMentions: number
  score: number
  confidence: number
  sentiment: Sentiment | null
} | null {
  const lower = issueText.toLowerCase()
  const mentionIndexes = competitorPhrases.flatMap((phrase) =>
    findMentionIndexes(lower, phrase),
  )

  if (mentionIndexes.length === 0) return null

  const mentionScores = mentionIndexes.map((idx) =>
    scoreMentionSentiment(getSentenceWindow(issueText, idx), options),
  )
  const scored = mentionScores.filter((m) => m.valenceTokens > 0)
  const scoredMentions = scored.length

  if (scoredMentions === 0) {
    return {
      mentionCount: mentionIndexes.length,
      scoredMentions: 0,
      score: 0,
      confidence: 0,
      sentiment: null,
    }
  }

  const avgScore = scored.reduce((sum, m) => sum + m.score, 0) / scoredMentions
  const avgConfidence = scored.reduce((sum, m) => sum + m.confidence, 0) / scoredMentions

  return {
    mentionCount: mentionIndexes.length,
    scoredMentions,
    score: Number(avgScore.toFixed(3)),
    confidence: Number(avgConfidence.toFixed(3)),
    sentiment: classifySentiment(avgScore),
  }
}

export function computeCompetitiveMentions(
  issues: CompetitiveIssueInput[],
  options: CompetitiveMentionsOptions = {}
): CompetitiveMention[] {
  const buckets = new Map<
    string,
    {
      total: number
      rawMentions: number
      scoredMentions: number
      confidenceSum: number
      confidenceWeightedMentions: number
      positive: number
      negative: number
      neutral: number
      sentimentSum: number
      sentimentWeight: number
      samples: CompetitiveMention["topIssues"]
    }
  >()

  for (const issue of issues) {
    const issueText = `${issue.title || ""} ${issue.content || ""}`.trim()
    if (!issueText) continue

    for (const [competitor, phrases] of Object.entries(COMPETITOR_KEYWORDS)) {
      // Detection phrases come exclusively from the canonical keyword list.
      // Deriving phrases from display names is a proven false-positive source
      // (e.g. "Sourcegraph Cody" → "sourcegraph" matching the company).
      //
      // Note: issue.sentiment is NOT passed through here. Using the post-level
      // ingest sentiment as a fallback would re-introduce P0-4 (a negative
      // post that name-drops a competitor would attribute negative sentiment
      // to that competitor without any mention-window evidence).
      const issueAggregate = aggregateCompetitorSentimentForIssue(issueText, phrases, options)
      if (!issueAggregate) continue

      const bucket = buckets.get(competitor) ?? {
        total: 0,
        rawMentions: 0,
        scoredMentions: 0,
        confidenceSum: 0,
        confidenceWeightedMentions: 0,
        positive: 0,
        negative: 0,
        neutral: 0,
        sentimentSum: 0,
        sentimentWeight: 0,
        samples: [],
      }

      bucket.total++
      bucket.rawMentions += issueAggregate.mentionCount
      bucket.scoredMentions += issueAggregate.scoredMentions

      // Only scored issues contribute to confidence/net-sentiment averages so
      // zero-evidence mentions don't dilute the KPIs.
      if (issueAggregate.scoredMentions > 0) {
        bucket.confidenceSum += issueAggregate.confidence
        bucket.confidenceWeightedMentions += 1
        bucket.sentimentSum += issueAggregate.score
        bucket.sentimentWeight += 1
      }

      if (issueAggregate.sentiment === "positive") bucket.positive++
      else if (issueAggregate.sentiment === "negative") bucket.negative++
      else if (issueAggregate.sentiment === "neutral") bucket.neutral++
      // sentiment === null → evidence-free mention; keep it out of bucket
      // positive/negative/neutral but still visible via rawMentions.

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
      competitor: COMPETITOR_DISPLAY_NAMES[competitor] || competitor,
      totalMentions: b.total,
      rawMentions: b.rawMentions,
      scoredMentions: b.scoredMentions,
      coverage: Number((b.scoredMentions / Math.max(1, b.rawMentions)).toFixed(2)),
      avgConfidence: Number(
        (b.confidenceSum / Math.max(1, b.confidenceWeightedMentions)).toFixed(2)
      ),
      positive: b.positive,
      negative: b.negative,
      neutral: b.neutral,
      netSentiment: Number((b.sentimentSum / Math.max(1, b.sentimentWeight)).toFixed(2)),
      topIssues: b.samples.sort((x, y) => y.impact_score - x.impact_score).slice(0, 3),
    }))
    .sort((a, b) => b.totalMentions - a.totalMentions)
}

export interface CompetitiveMentionsMeta {
  competitorsTracked: number
  /** Σ scoredMentions / Σ rawMentions, weighted by mention volume. */
  mentionCoverage: number
  /** Σ (avgConfidence × scoredMentions) / Σ scoredMentions, weighted. */
  avgConfidence: number
  /** Total number of mentions whose window had at least one valence token. */
  totalScoredMentions: number
}

/**
 * Summarize a `computeCompetitiveMentions` result into a dashboard-level meta
 * card. Weights are by mention volume so a single low-volume competitor does
 * not drag the KPI the same way a dozens-of-mentions competitor does. This
 * lives next to the producer so any future change to the per-competitor shape
 * can keep the aggregation in sync without hunting for inlined consumers.
 */
export function summarizeCompetitiveMentions(
  mentions: CompetitiveMention[],
): CompetitiveMentionsMeta {
  const totalRaw = mentions.reduce((sum, m) => sum + m.rawMentions, 0)
  const totalScored = mentions.reduce((sum, m) => sum + m.scoredMentions, 0)
  const weightedConfidence = mentions.reduce(
    (sum, m) => sum + m.avgConfidence * m.scoredMentions,
    0,
  )

  return {
    competitorsTracked: mentions.length,
    mentionCoverage: Number((totalRaw === 0 ? 0 : totalScored / totalRaw).toFixed(2)),
    avgConfidence: Number(
      (totalScored === 0 ? 0 : weightedConfidence / totalScored).toFixed(2),
    ),
    totalScoredMentions: totalScored,
  }
}
