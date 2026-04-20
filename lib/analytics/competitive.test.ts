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

test("comparative phrasing improves competitor sentiment around mention", () => {
  const aggregate = aggregateCompetitorSentimentForIssue(
    "Cursor is better than Codex for refactors.",
    ["cursor"]
  )

  assert.ok(aggregate)
  assert.equal(aggregate?.sentiment, "positive")
  assert.ok((aggregate?.score ?? 0) > 0)
})

test("mixed sentiment in same issue aggregates mention windows", () => {
  const aggregate = aggregateCompetitorSentimentForIssue(
    "Cursor IDE is great and reliable at autocomplete. Later in the day, Cursor IDE became slow and frustrating.",
    ["cursor"]
  )

  assert.ok(aggregate)
  assert.equal(aggregate?.mentionCount, 2)
  assert.equal(aggregate?.sentiment, "neutral")
})

test("anti-Codex but pro-competitor yields negative Codex and non-negative competitor", () => {
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
