import test from "node:test"
import assert from "node:assert/strict"

import { analyzeSentiment, categorizeIssue, detectCompetitorMentions, calculateImpactScore } from "../lib/scrapers/shared.ts"
import { computeRealtimeInsights, type RealtimeIssueInput } from "../lib/analytics/realtime.ts"
import type { Category } from "../lib/types.ts"

// Minimal category fixture mirroring the seed rows from
// scripts/002_create_issues_schema_v2.sql. Only `id` and `slug` are read by
// categorizeIssue; the other fields satisfy the Category type.
const CATEGORIES: Category[] = [
  { id: "cat-bug", slug: "bug", name: "Bug", color: "#ef4444", created_at: "" },
  { id: "cat-perf", slug: "performance", name: "Performance", color: "#f97316", created_at: "" },
  { id: "cat-fr", slug: "feature-request", name: "Feature Request", color: "#3b82f6", created_at: "" },
  { id: "cat-docs", slug: "documentation", name: "Documentation", color: "#10b981", created_at: "" },
  { id: "cat-ux", slug: "ux-ui", name: "UX/UI", color: "#8b5cf6", created_at: "" },
  { id: "cat-int", slug: "integration", name: "Integration", color: "#06b6d4", created_at: "" },
  { id: "cat-api", slug: "api", name: "API", color: "#14b8a6", created_at: "" },
  { id: "cat-price", slug: "pricing", name: "Pricing", color: "#eab308", created_at: "" },
  { id: "cat-sec", slug: "security", name: "Security", color: "#dc2626", created_at: "" },
  { id: "cat-other", slug: "other", name: "Other", color: "#6b7280", created_at: "" },
]

test("bug vocabulary contributes to keyword_presence without forcing negative sentiment", () => {
  const text = "Codex CLI bug report: command crashes with an error stack trace after update."
  const result = analyzeSentiment(text)

  assert.equal(result.sentiment, "neutral")
  assert.equal(result.score, 0)
  // "bug", "crashes", "error" each contribute once.
  assert.equal(result.keyword_presence, 3)

  // Because sentiment is neutral (not "negative"), calculateImpactScore does
  // not apply the 1.5× sentiment boost — the impact equals the pure engagement
  // score. Before this PR, the same text was classified negative and the
  // 1.5× boost inflated impact.
  const impact = calculateImpactScore(30, 12, result.sentiment)
  const neutralBaseline = calculateImpactScore(30, 12, "neutral")
  assert.equal(impact, neutralBaseline)
})

test("neutral feature requests remain neutral", () => {
  const text = "Feature request: please add workspace-level defaults for codex cli."
  const result = analyzeSentiment(text)

  assert.equal(result.sentiment, "neutral")
  assert.equal(result.keyword_presence, 0)
})

test("keyword_presence covers tense and plural variants", () => {
  // Each sentence exercises a variant not matched by bare-stem regexes.
  const cases: Array<[string, number]> = [
    ["Codex crashes on startup.", 1],
    ["The CLI crashed twice yesterday.", 1],
    ["Codex keeps crashing every few minutes.", 1],
    ["Two bugs filed, both errors from auth.", 2],
    ["The request failed with a 500.", 1],
    ["Intermittent failures when streaming.", 1],
    ["Recent regressions after the upgrade.", 1],
  ]

  for (const [text, expected] of cases) {
    const { keyword_presence } = analyzeSentiment(text)
    assert.equal(keyword_presence, expected, `"${text}" → expected ${expected}, got ${keyword_presence}`)
  }
})

test("valence word 'unusable' still drives negative sentiment", () => {
  const result = analyzeSentiment("This update made the CLI unusable for my team.")
  assert.equal(result.sentiment, "negative")
  assert.ok(result.score < 0)
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

// v2: eye-test Pattern C — category matcher assertions.
test("categorizeIssue v2: 'Open Codex CLI with open-source LLMs' is Integration, not Pricing", () => {
  // Row 5 from the eye test. v1 mislabeled this Pricing (likely via the bare
  // token 'open' triggering nothing and something else matching a Pricing
  // phrase). v2's `open-source llms` phrase locks Integration.
  const categoryId = categorizeIssue(
    "show hn: open codex – openai codex cli with open-source llms",
    CATEGORIES,
  )
  assert.equal(categoryId, "cat-int")
})

test("categorizeIssue v2: 'OpenAI Codex hands-on review' becomes Documentation", () => {
  // Row 4 from the eye test. v1 mislabeled this Other.
  const categoryId = categorizeIssue(
    "openai codex hands-on review",
    CATEGORIES,
  )
  assert.equal(categoryId, "cat-docs")
})

test("categorizeIssue v2: 'Unable to connect GitHub Auth' lands in a non-Other bucket", () => {
  // Row 15 from the eye test. The title legitimately has both Bug markers
  // (`unable to`, weight 2) and Integration markers (`github auth`, weight
  // 3; `connect`, weight 1). Integration wins on score, which is
  // domain-appropriate — it's an integration-setup failure. The key v2 fix
  // is that it's no longer Other.
  const categoryId = categorizeIssue(
    "unable to connect github auth to openai codex",
    CATEGORIES,
  )
  assert.notEqual(categoryId, "cat-other", "must not fall back to Other")
  // Spot-check the actual winner for documentation purposes.
  assert.equal(categoryId, "cat-int")
})

test("categorizeIssue v2: threshold lowered — a single phrase hit wins over Other", () => {
  // v1 required score ≥ 2 (e.g. two weight-1 hits or one weight-2 hit). v2
  // requires only score ≥ 1, so a lone `roadmap` (weight 1) now classifies.
  const categoryId = categorizeIssue(
    "is this on the roadmap for q3?",
    CATEGORIES,
  )
  assert.equal(categoryId, "cat-fr")
})

test("categorizeIssue v2: empty phrase-match still falls back to Other", () => {
  // Safety net — v2 only lowers the threshold; the no-match path is
  // preserved so genuinely uncategorizable titles still bucket Other.
  const categoryId = categorizeIssue(
    "hello world thanks everyone",
    CATEGORIES,
  )
  assert.equal(categoryId, "cat-other")
})

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
