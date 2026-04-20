import test from "node:test"
import assert from "node:assert/strict"

import {
  aggregateCompetitorSentimentForIssue,
  computeCompetitiveMentions,
  scoreMentionSentiment,
  type CompetitiveIssueInput,
} from "./competitive.ts"

test("mention sentiment handles basic negation phrases", () => {
  const fine = scoreMentionSentiment("Cursor is fine for quick edits")
  assert.equal(fine.sentiment, "positive")

  const notBad = scoreMentionSentiment("Cursor is not bad for this")
  assert.equal(notBad.sentiment, "positive")
  assert.ok(notBad.score > 0)
})

test("comparative phrasing against the anchor brand boosts competitor sentiment", () => {
  const aggregate = aggregateCompetitorSentimentForIssue(
    "Cursor is better than Codex for refactors.",
    ["cursor"],
  )

  assert.ok(aggregate)
  assert.equal(aggregate?.sentiment, "positive")
  assert.ok((aggregate?.score ?? 0) > 0)
})

test("comparative anchor is configurable per invocation", () => {
  const scored = aggregateCompetitorSentimentForIssue(
    "Windsurf is better than Cursor for web UI work.",
    ["windsurf"],
    { anchorBrand: "cursor" },
  )
  assert.ok(scored)
  assert.ok((scored?.score ?? 0) > 0)
})

test("mixed sentiment in same issue aggregates mention windows", () => {
  const aggregate = aggregateCompetitorSentimentForIssue(
    "Cursor IDE is great and reliable at autocomplete. Later in the day, Cursor IDE became slow and frustrating.",
    ["cursor ide"],
  )

  assert.ok(aggregate)
  assert.equal(aggregate?.mentionCount, 2)
  assert.equal(aggregate?.sentiment, "neutral")
})

test("anti-anchor but pro-competitor yields negative anchor and positive competitor", () => {
  const issues: CompetitiveIssueInput[] = [
    {
      id: "1",
      title: "Switching tools",
      content: "Codex is bad today, but Cursor IDE is better than Codex for this repo.",
      url: null,
      sentiment: "negative",
      impact_score: 7,
      published_at: null,
    },
    {
      id: "2",
      title: "Codex regression",
      content: "Codex is terrible and frustrating after update.",
      url: null,
      sentiment: "negative",
      impact_score: 8,
      published_at: null,
    },
  ]

  const mentions = computeCompetitiveMentions(issues)
  const cursor = mentions.find((m) => m.competitor === "Cursor")

  assert.ok(cursor)
  assert.equal(cursor?.negative, 0)
  assert.ok((cursor?.positive ?? 0) >= 1)
  assert.ok((cursor?.coverage ?? 0) > 0)
  assert.ok((cursor?.avgConfidence ?? 0) > 0)
})

// ---------- Regression tests for blockers flagged in PR review ----------

test("display names are not used as detection phrases (bare 'Sourcegraph' must not match)", () => {
  const issues: CompetitiveIssueInput[] = [
    {
      id: "1",
      title: "Sourcegraph is raising a new funding round",
      content: "The announcement covers their general search platform only.",
      url: null,
      sentiment: null,
      impact_score: 5,
      published_at: null,
    },
  ]

  const mentions = computeCompetitiveMentions(issues)
  const cody = mentions.find((m) => m.competitor === "Sourcegraph Cody")
  assert.equal(cody, undefined)
})

test("bare 'Gemini' corporate mentions do not fire Gemini Code detection", () => {
  const issues: CompetitiveIssueInput[] = [
    {
      id: "1",
      title: "Google Gemini product announcement",
      content: "Not referring to the code assistant at all.",
      url: null,
      sentiment: null,
      impact_score: 5,
      published_at: null,
    },
  ]

  const mentions = computeCompetitiveMentions(issues)
  const gemini = mentions.find((m) => m.competitor === "Gemini Code")
  assert.equal(gemini, undefined)
})

test("empty and whitespace-only issues are skipped cleanly", () => {
  const issues: CompetitiveIssueInput[] = [
    { id: "1", title: "", content: null, url: null, sentiment: null, impact_score: 0, published_at: null },
    { id: "2", title: "   ", content: "   ", url: null, sentiment: null, impact_score: 0, published_at: null },
  ]

  const mentions = computeCompetitiveMentions(issues)
  assert.deepEqual(mentions, [])
})

test("mention with no valence tokens returns null sentiment and zero confidence", () => {
  const result = scoreMentionSentiment("Cursor IDE and Claude Code were both mentioned.")
  assert.equal(result.sentiment, null)
  assert.equal(result.confidence, 0)
})

test("zero-evidence mention falls back to the ingest-time sentiment when provided", () => {
  const aggregate = aggregateCompetitorSentimentForIssue(
    "Cursor IDE was discussed today.",
    ["cursor ide"],
    { fallbackSentiment: "positive" },
  )
  assert.ok(aggregate)
  assert.equal(aggregate?.sentiment, "positive")
  assert.equal(aggregate?.confidence, 0)
  assert.equal(aggregate?.scoredMentions, 0)
})

test("topIssues preserves nullable sentiment contract for zero-evidence mentions", () => {
  const issues: CompetitiveIssueInput[] = [
    {
      id: "1",
      title: "Cursor IDE weekly check-in",
      content: "We discussed Cursor IDE in the weekly.",
      url: null,
      sentiment: null,
      impact_score: 3,
      published_at: null,
    },
  ]

  const mentions = computeCompetitiveMentions(issues)
  const cursor = mentions.find((m) => m.competitor === "Cursor")
  assert.ok(cursor)
  assert.equal(cursor?.topIssues[0]?.sentiment, null)
})

test("word boundaries prevent substring matches inside identifiers", () => {
  const issues: CompetitiveIssueInput[] = [
    {
      id: "1",
      title: "Refactoring helpers",
      content: "The function myCursorHelper and cursorPosition utility are both slow.",
      url: null,
      sentiment: "negative",
      impact_score: 5,
      published_at: null,
    },
  ]

  const mentions = computeCompetitiveMentions(issues)
  assert.equal(mentions.find((m) => m.competitor === "Cursor"), undefined)
})

test("negators beyond the lookback window do not flip polarity", () => {
  const result = scoreMentionSentiment("it is not the case that someone said great")
  assert.equal(result.sentiment, "positive")
})

test("strict sentence window does not leak sentiment from neighboring sentences", () => {
  const aggregate = aggregateCompetitorSentimentForIssue(
    "Cursor IDE is completely unremarkable in my daily use. The weather is great today!",
    ["cursor ide"],
  )
  assert.ok(aggregate)
  assert.equal(aggregate?.scoredMentions, 0)
  assert.equal(aggregate?.sentiment, null)
})
