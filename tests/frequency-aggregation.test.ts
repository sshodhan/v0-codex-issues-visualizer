import test from "node:test"
import assert from "node:assert/strict"

interface IssueRow {
  source_id: string
  external_id: string
  title: string
  content: string | null
  sentiment: "positive" | "negative" | "neutral"
  impact_score: number
  frequency_count: number
  last_seen_at: string
}

function upsertIssueObservation(
  rows: Map<string, IssueRow>,
  observation: Omit<IssueRow, "frequency_count">,
) {
  const key = `${observation.source_id}::${observation.external_id}`
  const existing = rows.get(key)

  if (!existing) {
    rows.set(key, { ...observation, frequency_count: 1 })
    return
  }

  rows.set(key, {
    ...existing,
    ...observation,
    frequency_count: existing.frequency_count + 1,
  })
}

test("frequency aggregation increments deterministicly and updates last_seen_at", async () => {
  const rows = new Map<string, IssueRow>()

  upsertIssueObservation(rows, {
    source_id: "source-1",
    external_id: "abc-123",
    title: "First title",
    content: "Original content",
    sentiment: "negative",
    impact_score: 6,
    last_seen_at: "2026-04-21T00:00:00.000Z",
  })

  upsertIssueObservation(rows, {
    source_id: "source-1",
    external_id: "abc-123",
    title: "Edited title",
    content: "Updated content",
    sentiment: "neutral",
    impact_score: 8,
    last_seen_at: "2026-04-21T00:05:00.000Z",
  })

  upsertIssueObservation(rows, {
    source_id: "source-1",
    external_id: "abc-123",
    title: "Edited title v2",
    content: "Updated content v2",
    sentiment: "positive",
    impact_score: 9,
    last_seen_at: "2026-04-21T00:10:00.000Z",
  })

  const issue = rows.get("source-1::abc-123")
  assert.ok(issue)
  assert.equal(issue.frequency_count, 3)
  assert.equal(issue.last_seen_at, "2026-04-21T00:10:00.000Z")
  assert.equal(issue.title, "Edited title v2")
  assert.equal(issue.content, "Updated content v2")
  assert.equal(issue.sentiment, "positive")
  assert.equal(issue.impact_score, 9)
})
