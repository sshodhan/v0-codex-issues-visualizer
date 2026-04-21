type Sentiment = "positive" | "negative" | "neutral"

export interface RealtimeIssueInput {
  id: string
  title: string
  url: string | null
  published_at: string | null
  sentiment: Sentiment | null
  impact_score: number | null
  category: { name: string; slug: string; color: string } | null
  source: { name: string; slug: string } | null
}

export interface RealtimeInsight {
  category: { name: string; slug: string; color: string }
  nowCount: number
  previousCount: number
  momentum: number
  avgImpact: number
  negativeRatio: number
  sourceDiversity: number
  urgencyScore: number
  topIssues: Array<{
    id: string
    title: string
    url: string | null
    source: string
    impact_score: number
  }>
}

/**
 * Compute urgency-ranked category insights from a window of recent issues.
 *
 * Weights blend volume, momentum (vs prior window), impact,
 * and source diversity. Newer issues inside the "now" window get a mild
 * recency boost so a story that broke 12h ago counts more than one that
 * broke 70h ago.
 */
export function computeRealtimeInsights(
  issues: RealtimeIssueInput[],
  now: Date = new Date(),
  windowHours = 72
): RealtimeInsight[] {
  const windowMs = windowHours * 60 * 60 * 1000
  const nowCutoff = new Date(now.getTime() - windowMs)
  const prevCutoff = new Date(now.getTime() - windowMs * 2)

  type Bucket = {
    category: { name: string; slug: string; color: string }
    nowCount: number
    previousCount: number
    negativeCount: number
    impactTotal: number
    decayedVolume: number
    sources: Set<string>
    samples: Array<{
      id: string
      title: string
      url: string | null
      source: string
      impact_score: number
    }>
  }

  const buckets = new Map<string, Bucket>()

  for (const issue of issues) {
    if (!issue.published_at || !issue.category) continue
    const publishedAt = new Date(issue.published_at)
    if (publishedAt < prevCutoff) continue

    const key = issue.category.slug
    const bucket = buckets.get(key) ?? {
      category: issue.category,
      nowCount: 0,
      previousCount: 0,
      negativeCount: 0,
      impactTotal: 0,
      decayedVolume: 0,
      sources: new Set<string>(),
      samples: [],
    }

    if (publishedAt >= nowCutoff) {
      bucket.nowCount++
      bucket.impactTotal += issue.impact_score || 0
      if (issue.sentiment === "negative") bucket.negativeCount++

      // Linear decay: 1.0 at "just now" → 0.0 at the window edge.
      const ageMs = now.getTime() - publishedAt.getTime()
      const recency = Math.max(0, 1 - ageMs / windowMs)
      bucket.decayedVolume += recency

      if (issue.source?.name) bucket.sources.add(issue.source.name)

      bucket.samples.push({
        id: issue.id,
        title: issue.title,
        url: issue.url,
        source: issue.source?.name || "Unknown",
        impact_score: issue.impact_score || 0,
      })
    } else {
      bucket.previousCount++
    }

    buckets.set(key, bucket)
  }

  return Array.from(buckets.values())
    .filter((b) => b.nowCount > 0)
    .map((b) => {
      const momentum = b.nowCount - b.previousCount
      const avgImpact = b.impactTotal / b.nowCount
      const negativeRatio = b.negativeCount / b.nowCount
      const sourceDiversity = b.sources.size

      const urgencyScore = Number(
        (
          b.decayedVolume * 1.6 +
          Math.max(momentum, 0) * 1.4 +
          avgImpact * 1.0 +
          (sourceDiversity - 1) * 0.8
        ).toFixed(2)
      )

      return {
        category: b.category,
        nowCount: b.nowCount,
        previousCount: b.previousCount,
        momentum,
        avgImpact: Number(avgImpact.toFixed(2)),
        negativeRatio: Number((negativeRatio * 100).toFixed(1)),
        sourceDiversity,
        urgencyScore,
        topIssues: b.samples
          .sort((x, y) => y.impact_score - x.impact_score)
          .slice(0, 3),
      }
    })
    .sort((a, b) => b.urgencyScore - a.urgencyScore)
    .slice(0, 6)
}
