import { COMPETITOR_KEYWORDS } from "@/lib/scrapers/shared"

type Sentiment = "positive" | "negative" | "neutral"

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
  positive: number
  negative: number
  neutral: number
  netSentiment: number // -1..1, weighted by mention count
  topIssues: Array<{
    id: string
    title: string
    url: string | null
    sentiment: Sentiment | null
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

export function computeCompetitiveMentions(
  issues: CompetitiveIssueInput[]
): CompetitiveMention[] {
  const buckets = new Map<
    string,
    {
      total: number
      positive: number
      negative: number
      neutral: number
      sentimentSum: number
      samples: CompetitiveMention["topIssues"]
    }
  >()

  for (const issue of issues) {
    const haystack = `${issue.title || ""} ${issue.content || ""}`.toLowerCase()
    if (!haystack.trim()) continue

    for (const [competitor, phrases] of Object.entries(COMPETITOR_KEYWORDS)) {
      if (!phrases.some((p) => haystack.includes(p.trim()))) continue

      const bucket = buckets.get(competitor) ?? {
        total: 0,
        positive: 0,
        negative: 0,
        neutral: 0,
        sentimentSum: 0,
        samples: [],
      }

      bucket.total++
      if (issue.sentiment === "positive") {
        bucket.positive++
        bucket.sentimentSum += 1
      } else if (issue.sentiment === "negative") {
        bucket.negative++
        bucket.sentimentSum -= 1
      } else {
        bucket.neutral++
      }

      bucket.samples.push({
        id: issue.id,
        title: issue.title,
        url: issue.url,
        sentiment: issue.sentiment,
        impact_score: issue.impact_score || 0,
      })

      buckets.set(competitor, bucket)
    }
  }

  return Array.from(buckets.entries())
    .map(([competitor, b]) => ({
      competitor: PRETTY_NAME[competitor] || competitor,
      totalMentions: b.total,
      positive: b.positive,
      negative: b.negative,
      neutral: b.neutral,
      netSentiment: Number((b.sentimentSum / b.total).toFixed(2)),
      topIssues: b.samples
        .sort((x, y) => y.impact_score - x.impact_score)
        .slice(0, 3),
    }))
    .sort((a, b) => b.totalMentions - a.totalMentions)
}
