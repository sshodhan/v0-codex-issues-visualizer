import test from "node:test"
import assert from "node:assert/strict"

import { composeWhySurfaced } from "../lib/classification/why-surfaced.ts"

// Tests for the V3 card's "why surfaced" composer. Every invariant here
// is about honesty: a clause may only appear when a real signal crosses
// its threshold, and absent signals must NEVER be fabricated. The caller
// is expected to substitute a legacy fallback when this returns null.

test("composeWhySurfaced returns null when no signal crosses threshold", () => {
  // Thin cluster: small impact, no severity, no sentiment, no surge, no
  // unreviewed backlog. The composer must refuse to invent a narrative.
  const result = composeWhySurfaced({
    avg_impact: 2.0,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: 0,
  })
  assert.equal(result, null)
})

test("composeWhySurfaced includes surge clause when |delta| >= 25%", () => {
  const result = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: 340,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.ok(result, "expected a composed sentence for +340% surge")
  assert.match(result!, /\+340% volume change in the last 6 hours/)
  assert.match(result!, /\.$/, "must terminate with a period")
})

test("composeWhySurfaced suppresses surge clause below 25% threshold", () => {
  // +10% is noise, not a surge. Must not appear in the narrative.
  const result = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: 10,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.equal(result, null)
})

test("composeWhySurfaced phrases negative surge with leading minus", () => {
  const result = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: -60,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.ok(result)
  assert.match(result!, /-60% volume change/)
})

test("composeWhySurfaced renders severity clause only for high/critical", () => {
  const high = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: "high",
    negative_sentiment_pct: null,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.ok(high)
  assert.match(high!, /dominant high severity/)

  const critical = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: "critical",
    negative_sentiment_pct: null,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.ok(critical)
  assert.match(critical!, /dominant critical severity/)

  // "medium" and "low" don't explain why the cluster got ranked up —
  // they must NOT appear in the narrative.
  const medium = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: "medium",
    negative_sentiment_pct: null,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.equal(medium, null)
})

test("composeWhySurfaced drops sentiment clause below 50% threshold", () => {
  // 40% negative is just the typical complaint rate; not loud enough
  // to be a reason this cluster got surfaced.
  const result = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: null,
    negative_sentiment_pct: 40,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.equal(result, null)
})

test("composeWhySurfaced includes sentiment clause at or above 50%", () => {
  const result = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: null,
    negative_sentiment_pct: 65,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.ok(result)
  assert.match(result!, /65% negative sentiment/)
})

test("composeWhySurfaced drops avg_impact clause below MIN_AVG_IMPACT_FOR_NARRATIVE", () => {
  // impact < 4 isn't a reason the cluster should be surfaced.
  const result = composeWhySurfaced({
    avg_impact: 2.5,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.equal(result, null)
})

test("composeWhySurfaced includes avg_impact clause at or above threshold", () => {
  const result = composeWhySurfaced({
    avg_impact: 4.8,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.ok(result)
  assert.match(result!, /4\.8 avg impact/)
})

test("composeWhySurfaced renders integer impact without decimal", () => {
  // 5.0 must appear as "5" in the card, not "5.0" — minor but
  // consistent with how the mock reads ("4.8 avg impact", "5 avg impact").
  const result = composeWhySurfaced({
    avg_impact: 5.0,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: null,
  })
  assert.ok(result)
  assert.match(result!, /5 avg impact/)
  assert.doesNotMatch(result!, /5\.0 avg impact/)
})

test("composeWhySurfaced includes unreviewed clause for backlog >= 5", () => {
  const result = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: null,
    surge_window_hours: 6,
    review_pressure_input: 12,
  })
  assert.ok(result)
  assert.match(result!, /12 unreviewed/)
})

test("composeWhySurfaced caps at 3 clauses, ordered by strength", () => {
  // All clauses fire: surge (340), critical severity (90), negative
  // sentiment (65), avg impact 4.8*10=48, unreviewed min(60, 12*2=24) = 24.
  // Top 3 by strength: surge (340), severity (90), sentiment (65).
  // Must NOT include avg-impact or unreviewed.
  const result = composeWhySurfaced({
    avg_impact: 4.8,
    dominant_severity: "critical",
    negative_sentiment_pct: 65,
    surge_delta_pct: 340,
    surge_window_hours: 6,
    review_pressure_input: 12,
  })
  assert.ok(result)
  const clauseCount = result!.split(",").length
  assert.equal(clauseCount, 3, `expected 3 clauses, got: ${result}`)
  assert.match(result!, /\+340% volume change/)
  assert.match(result!, /dominant critical severity/)
  assert.match(result!, /65% negative sentiment/)
  assert.doesNotMatch(result!, /avg impact/)
  assert.doesNotMatch(result!, /unreviewed/)
})

test("composeWhySurfaced never fabricates 'momentum' or 'escalating' phrasing", () => {
  // Anti-regression: these words imply measurements we don't take.
  // The plan in /root/.claude/plans/what-are-the-key-async-giraffe.md
  // documents why these were dropped.
  const result = composeWhySurfaced({
    avg_impact: 8.0,
    dominant_severity: "critical",
    negative_sentiment_pct: 90,
    surge_delta_pct: 500,
    surge_window_hours: 6,
    review_pressure_input: 50,
  })
  assert.ok(result)
  assert.doesNotMatch(result!, /momentum/i)
  assert.doesNotMatch(result!, /escalating/i)
})

test("composeWhySurfaced handles missing surge_window_hours by defaulting to 6", () => {
  // Defensive: older cached responses may not include surge_window_hours.
  const result = composeWhySurfaced({
    avg_impact: null,
    dominant_severity: null,
    negative_sentiment_pct: null,
    surge_delta_pct: 80,
    surge_window_hours: null,
    review_pressure_input: null,
  })
  assert.ok(result)
  assert.match(result!, /last 6 hours/)
})
