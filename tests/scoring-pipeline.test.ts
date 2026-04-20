import test from "node:test"
import assert from "node:assert/strict"

import { analyzeSentiment, detectCompetitorMentions, calculateImpactScore } from "../lib/scrapers/shared.ts"
import { computeRealtimeInsights, type RealtimeIssueInput } from "../lib/analytics/realtime.ts"

test("bug vocabulary contributes to keyword_presence without forcing negative sentiment", () => {
  const text = "Codex CLI bug report: command crashes with an error stack trace after update."
  const result = analyzeSentiment(text)

  assert.equal(result.sentiment, "neutral")
  assert.equal(result.score, 0)
  assert.ok(result.keyword_presence > 0)

  const impact = calculateImpactScore(30, 12, result.sentiment)
  const oldDoublePenaltyImpact = calculateImpactScore(30, 12, "negative")
  assert.ok(impact < oldDoublePenaltyImpact)
})

test("neutral feature requests remain neutral", () => {
  const text = "Feature request: please add workspace-level defaults for codex cli."
  const result = analyzeSentiment(text)

  assert.equal(result.sentiment, "neutral")
  assert.equal(result.keyword_presence, 0)
})

test("positive comparator mentions stay positive while tracking competitors", () => {
  const text = "I love Codex. It feels faster than Cursor IDE and GitHub Copilot right now."
  const result = analyzeSentiment(text)
  const competitors = detectCompetitorMentions(text)

  assert.equal(result.sentiment, "positive")
  assert.ok(result.score > 0)
  assert.deepEqual(new Set(competitors), new Set(["cursor", "copilot"]))
})

function computePreviousUrgency(issues: RealtimeIssueInput[], now: Date, windowHours = 72) {
  const insights = computeRealtimeInsights(issues, now, windowHours)

  // Rebuild previous urgency by adding back the removed negativeRatio multiplier.
  return insights
    .map((i) => ({
      ...i,
      urgencyScore: Number((i.urgencyScore + (i.negativeRatio / 100) * 3).toFixed(2)),
    }))
    .sort((a, b) => b.urgencyScore - a.urgencyScore)
}

test("recent-window rank shifts when removing duplicate negative weighting", () => {
  const now = new Date("2026-04-20T12:00:00.000Z")

  const makeIssue = (
    id: string,
    category: "bug" | "feature-request",
    sentiment: "positive" | "negative" | "neutral",
    impact_score: number,
    hoursAgo: number,
    source: string
  ): RealtimeIssueInput => ({
    id,
    title: `${category} issue ${id}`,
    url: null,
    published_at: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString(),
    sentiment,
    impact_score,
    category: {
      name: category === "bug" ? "Bug" : "Feature Request",
      slug: category,
      color: category === "bug" ? "#ef4444" : "#3b82f6",
    },
    source: { name: source, slug: source.toLowerCase() },
  })

  const issues: RealtimeIssueInput[] = [
    makeIssue("b1", "bug", "negative", 2, 1, "Reddit"),
    makeIssue("b2", "bug", "negative", 2, 4, "GitHub"),
    makeIssue("f1", "feature-request", "neutral", 4, 2, "Reddit"),
    makeIssue("f2", "feature-request", "neutral", 4, 6, "Hacker News"),
  ]

  const current = computeRealtimeInsights(issues, now, 72)
  const previous = computePreviousUrgency(issues, now, 72)

  assert.equal(previous[0]?.category.slug, "bug")
  assert.equal(current[0]?.category.slug, "feature-request")
})
