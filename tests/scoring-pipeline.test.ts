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
  { id: "cat-mq", slug: "model-quality", name: "Model Quality", color: "#a855f7", created_at: "" },
  { id: "cat-sec", slug: "security", name: "Security", color: "#dc2626", created_at: "" },
  { id: "cat-other", slug: "other", name: "Other", color: "#6b7280", created_at: "" },
]

// v5: categorizeIssue takes (title, body, categories) and returns a
// TopicResult { categoryId, slug, confidence, evidence } | null. The
// historical assertions in this file all pass a single string and compare
// against a category id; this thin helper preserves that contract by
// running the input as a title with empty body, then unwrapping the
// categoryId. Helper is test-only — production code consumes the full
// TopicResult to persist evidence.
function classifyTitle(title: string): string | undefined {
  return categorizeIssue(title, "", CATEGORIES)?.categoryId
}

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
  const categoryId = classifyTitle(
    "show hn: open codex – openai codex cli with open-source llms",
  )
  assert.equal(categoryId, "cat-int")
})

test("categorizeIssue v2: 'OpenAI Codex hands-on review' becomes Documentation", () => {
  // Row 4 from the eye test. v1 mislabeled this Other.
  const categoryId = classifyTitle("openai codex hands-on review")
  assert.equal(categoryId, "cat-docs")
})

test("categorizeIssue v4: 'mcp timeout' is Integration (not Performance)", () => {
  const categoryId = classifyTitle("mcp timeout after provider update")
  assert.equal(categoryId, "cat-int")
})

test("categorizeIssue v4: quota exceeded + billing details is Pricing (not API)", () => {
  const categoryId = classifyTitle("quota exceeded. check your plan and billing details.")
  assert.equal(categoryId, "cat-price")
})

test("categorizeIssue v4: looping complaint is Model Quality", () => {
  const categoryId = classifyTitle("cursor keeps looping on same message")
  assert.equal(categoryId, "cat-mq")
})

test("categorizeIssue v4: approval prompt + diff details is UX/UI", () => {
  const categoryId = classifyTitle("subagent patch approval prompt omits diff/file details")
  assert.equal(categoryId, "cat-ux")
})

test("categorizeIssue v4: replace_in_file mismatch is Integration", () => {
  const categoryId = classifyTitle(
    "replace_in_file says code was modified but no file changes",
  )
  assert.equal(categoryId, "cat-int")
})

test("categorizeIssue v2: 'Unable to connect GitHub Auth' lands in a non-Other bucket", () => {
  // Row 15 from the eye test. The title legitimately has both Bug markers
  // (`unable to`, weight 2) and Integration markers (`github auth`, weight
  // 3; `connect`, weight 1). Integration wins on score, which is
  // domain-appropriate — it's an integration-setup failure. The key v2 fix
  // is that it's no longer Other.
  const categoryId = classifyTitle("unable to connect github auth to openai codex")
  assert.notEqual(categoryId, "cat-other", "must not fall back to Other")
  // Spot-check the actual winner for documentation purposes.
  assert.equal(categoryId, "cat-int")
})

test("categorizeIssue v2: a lone weight-1 phrase does NOT win over Other (threshold=2 preserved)", () => {
  // Pre-merge review caught that lowering the threshold to 1 let single
  // weight-1 hits (`roadmap`, `example`, `connect`) pull posts out of Other
  // on thin evidence. We kept the v1 floor of 2 and instead relied on v2's
  // phrase-list expansion (stronger signals at weights 2–3) to classify
  // eye-test rows. A solitary `roadmap` is still Other.
  const categoryId = classifyTitle("is this on the roadmap for q3?")
  assert.equal(categoryId, "cat-other")
})

test("categorizeIssue v3: 'distracted by excessive Frontend guidance in system prompt' is Model Quality, not Pricing", () => {
  // v2 mislabeled this Pricing — bodies mentioning "plan" (weight 1, wholeWord)
  // could clear the threshold of 2 alongside any other weight-1 hit, even
  // when the post was clearly about model behavior. v3 drops bare `plan`
  // from Pricing and introduces a model-quality slot that locks onto
  // `distracted` (2) + `system prompt` (2) = 4, well above threshold.
  const categoryId = classifyTitle(
    'make gpt-5.5 not get distracted by excessive "frontend guidance" in system prompt',
  )
  assert.equal(categoryId, "cat-mq")
})

test("categorizeIssue v3: legitimate pricing posts still classify as Pricing", () => {
  // Tightening Pricing must not regress true positives. "Pro plan" + "expensive"
  // (3 + 3) and a bare "pricing" mention (3) both still clear the threshold.
  assert.equal(
    classifyTitle("the pro plan is too expensive for individual devs"),
    "cat-price",
  )
  assert.equal(
    classifyTitle("question about codex cli pricing for teams"),
    "cat-price",
  )
})

test("categorizeIssue v3: bare 'plan' no longer pulls posts into Pricing", () => {
  // v2 regression we're fixing: a single mention of "plan" in a non-pricing
  // context shouldn't drag a post into Pricing. This title has "plan" + a
  // weight-1 hit (`connect`) — under v2 that summed to 2 and won Pricing
  // outright. Under v3 there's no `plan` entry, so neither category clears
  // the threshold and we fall back to Other.
  const categoryId = classifyTitle("i plan to connect codex with my own setup")
  assert.notEqual(categoryId, "cat-price", "must not classify as Pricing")
})

test("categorizeIssue v3: hallucination complaints land in Model Quality", () => {
  const categoryId = classifyTitle("codex hallucinates imports that don't exist")
  assert.equal(categoryId, "cat-mq")
})

test("categorizeIssue v2: empty phrase-match still falls back to Other", () => {
  // Safety net — v2 only lowers the threshold; the no-match path is
  // preserved so genuinely uncategorizable titles still bucket Other.
  const categoryId = classifyTitle("hello world thanks everyone")
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

// Helper used by the coverage / reachability tests below. Builds one
// observation per slug at the requested age, with deterministic non-zero
// impact so urgency math runs end-to-end.
function obsAt(
  id: string,
  cat: Category,
  hoursAgo: number,
  now: Date,
  impact = 5,
): RealtimeIssueInput {
  return {
    id,
    title: `${cat.slug} ${id}`,
    url: null,
    published_at: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString(),
    sentiment: "neutral",
    impact_score: impact,
    category: { name: cat.name, slug: cat.slug, color: cat.color },
    source: { name: "Reddit", slug: "reddit" },
  }
}

test("computeRealtimeInsights returns every active slug (no top-N cap)", () => {
  // Coverage invariant: with one observation in each of the 11 taxonomy
  // slugs inside the 72h window, the result must contain all 11. The
  // historical `.slice(0, 6)` cap was the symptom in the
  // hot-themes-coverage-proposal note.
  const now = new Date("2026-04-28T12:00:00.000Z")
  const issues = CATEGORIES.map((c, i) => obsAt(`o-${c.slug}`, c, 24 + i, now))

  const result = computeRealtimeInsights(issues, now, 72)

  assert.equal(result.length, CATEGORIES.length, "expected one row per active slug")
  const slugs = new Set(result.map((r) => r.category.slug))
  for (const cat of CATEGORIES) {
    assert.ok(slugs.has(cat.slug), `missing slug ${cat.slug}`)
  }
})

test("computeRealtimeInsights: lead story is the row with highest urgencyScore", () => {
  // Stability invariant: the lead-story / followers split contract reads
  // result[0] as the lead. The sort must put the highest-urgency row there
  // regardless of how many rows survive the filter.
  const now = new Date("2026-04-28T12:00:00.000Z")
  const cat = (slug: string) => CATEGORIES.find((c) => c.slug === slug)!

  const issues: RealtimeIssueInput[] = [
    // bug: 5 hot recent observations
    obsAt("b1", cat("bug"), 1, now, 8),
    obsAt("b2", cat("bug"), 2, now, 8),
    obsAt("b3", cat("bug"), 3, now, 8),
    obsAt("b4", cat("bug"), 4, now, 8),
    obsAt("b5", cat("bug"), 5, now, 8),
    // security: 1 quiet recent observation
    obsAt("s1", cat("security"), 24, now, 5),
  ]

  const result = computeRealtimeInsights(issues, now, 72)
  const maxUrgency = Math.max(...result.map((r) => r.urgencyScore))
  assert.equal(result[0]?.urgencyScore, maxUrgency)
  assert.equal(result[0]?.category.slug, "bug")
})

test("computeRealtimeInsights: prior-window-only categories surface with zeroed display metrics", () => {
  // Empty-bucket policy: a slug with activity 73-144h ago but none in the
  // last 72h is still reachable, so reviewers can see the category exists
  // and is decaying. Display fields (avgImpact, negativeRatio) are zero
  // rather than NaN; urgencyScore ranks below every active bucket.
  const now = new Date("2026-04-28T12:00:00.000Z")
  const cat = (slug: string) => CATEGORIES.find((c) => c.slug === slug)!

  const issues: RealtimeIssueInput[] = [
    obsAt("b1", cat("bug"), 1, now, 8),
    obsAt("b2", cat("bug"), 2, now, 8),
    // documentation: only in the prior window
    obsAt("d1", cat("documentation"), 100, now, 5),
    obsAt("d2", cat("documentation"), 110, now, 5),
  ]

  const result = computeRealtimeInsights(issues, now, 72)
  const docs = result.find((r) => r.category.slug === "documentation")

  assert.ok(docs, "documentation must surface even with 0 nowCount")
  assert.equal(docs!.nowCount, 0)
  assert.equal(docs!.previousCount, 2)
  assert.equal(docs!.avgImpact, 0)
  assert.equal(docs!.negativeRatio, 0)
  assert.ok(docs!.urgencyScore < (result.find((r) => r.category.slug === "bug")!.urgencyScore))
})

test("computeRealtimeInsights: low-volume slugs reach the panel within their 72h window", () => {
  // Reachability test mirroring the 2026-04-28 production data point —
  // a single observation in `model-quality` plus high-volume churn in
  // other slugs must still surface model-quality so the topic-chip filter
  // can find it (computeHeroInsight reads result[i] by slug match).
  const now = new Date("2026-04-28T12:00:00.000Z")
  const cat = (slug: string) => CATEGORIES.find((c) => c.slug === slug)!

  const issues: RealtimeIssueInput[] = []
  // 18 integration observations
  for (let i = 0; i < 18; i++) {
    issues.push(obsAt(`i${i}`, cat("integration"), 1 + i, now, 8))
  }
  // 11 bug
  for (let i = 0; i < 11; i++) {
    issues.push(obsAt(`b${i}`, cat("bug"), 1 + i, now, 8))
  }
  // 1 model-quality
  issues.push(obsAt("mq1", cat("model-quality"), 60, now, 5))

  const result = computeRealtimeInsights(issues, now, 72)
  const mq = result.find((r) => r.category.slug === "model-quality")
  assert.ok(mq, "model-quality with 1 obs in 72h must reach the result")
  assert.equal(mq!.nowCount, 1)
})
