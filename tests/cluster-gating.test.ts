import test from "node:test"
import assert from "node:assert/strict"

import {
  dominantSeverity,
  negativeSentimentPct,
  surgeDeltaPct,
} from "../lib/classification/cluster-gating.ts"

// Honesty invariants for the V3 rollup gating layer. Every test here
// protects against rendering a misleading statistic on the V3 card —
// things like "+200%" off a 1→3 spike, or "HIGH SEVERITY" on a cluster
// that's only 30% classified.

// ─── surgeDeltaPct ────────────────────────────────────────────────────────

test("surgeDeltaPct returns null when prior window is empty", () => {
  // A brand-new cluster has no "prior" — we must not pretend the
  // appearance of 5 new observations represents a percentage change.
  assert.equal(surgeDeltaPct(5, 0), null)
})

test("surgeDeltaPct returns null when prior window is below sample threshold", () => {
  // 1→3 is technically "+200%" but the denominator is too small for
  // the percentage to mean anything. Withhold.
  assert.equal(surgeDeltaPct(3, 1), null)
  assert.equal(surgeDeltaPct(10, 2), null)
})

test("surgeDeltaPct returns positive integer for growing cluster", () => {
  assert.equal(surgeDeltaPct(34, 10), 240)
  assert.equal(surgeDeltaPct(15, 10), 50)
})

test("surgeDeltaPct returns zero when counts match", () => {
  // Stable volume — card renders "stable" in the caption layer.
  assert.equal(surgeDeltaPct(10, 10), 0)
})

test("surgeDeltaPct returns negative for decaying cluster", () => {
  assert.equal(surgeDeltaPct(5, 10), -50)
  assert.equal(surgeDeltaPct(1, 10), -90)
})

test("surgeDeltaPct rounds to nearest integer", () => {
  // (13 - 10) / 10 * 100 = 30; (14 - 10) / 10 * 100 = 40
  assert.equal(surgeDeltaPct(13, 10), 30)
  assert.equal(surgeDeltaPct(14, 10), 40)
})

// ─── dominantSeverity ─────────────────────────────────────────────────────

const severity = (low: number, medium: number, high: number, critical: number) => ({
  low, medium, high, critical,
})

test("dominantSeverity returns null below 50% classified share", () => {
  // Gate: cluster is only 30% classified — the "dominant" severity is
  // the dominant severity of the classified half, a biased statistic
  // that would mislead the reviewer into thinking the whole cluster
  // trends high-severity.
  assert.equal(
    dominantSeverity(severity(0, 2, 8, 0), 10, 0.3),
    null,
  )
})

test("dominantSeverity returns argmax when classified share meets threshold", () => {
  assert.equal(
    dominantSeverity(severity(0, 2, 8, 0), 10, 0.6),
    "high",
  )
  assert.equal(
    dominantSeverity(severity(1, 3, 2, 4), 10, 1.0),
    "critical",
  )
})

test("dominantSeverity tie-breaks toward most severe label", () => {
  // 5 high / 5 critical — pick critical.
  assert.equal(
    dominantSeverity(severity(0, 0, 5, 5), 10, 0.8),
    "critical",
  )
})

test("dominantSeverity returns null when nothing classified", () => {
  assert.equal(
    dominantSeverity(severity(0, 0, 0, 0), 0, 1.0),
    null,
  )
})

test("dominantSeverity returns null at exactly-zero count despite passing gate", () => {
  // Defensive: if the distribution object is all zeros but the gate
  // passes (edge case: 0/0 classifiedShare treated as 0.6 upstream),
  // we still must not return a severity label.
  assert.equal(
    dominantSeverity(severity(0, 0, 0, 0), 10, 0.6),
    null,
  )
})

// ─── negativeSentimentPct ─────────────────────────────────────────────────

const sentiment = (positive: number, neutral: number, negative: number) => ({
  positive, neutral, negative,
})

test("negativeSentimentPct returns null when cluster is too small", () => {
  // 2 sentiment-labeled rows — one negative report flips the ratio
  // from 0% to 50%. Not a meaningful signal at this sample size.
  assert.equal(
    negativeSentimentPct(sentiment(1, 0, 1), 2),
    null,
  )
  assert.equal(
    negativeSentimentPct(sentiment(0, 0, 0), 0),
    null,
  )
})

test("negativeSentimentPct returns rounded integer at or above threshold", () => {
  // 3 labeled, 2 negative = 67%
  assert.equal(
    negativeSentimentPct(sentiment(1, 0, 2), 3),
    67,
  )
  // 10 labeled, 6 negative = 60%
  assert.equal(
    negativeSentimentPct(sentiment(2, 2, 6), 10),
    60,
  )
})

test("negativeSentimentPct returns zero when no negative labels", () => {
  assert.equal(
    negativeSentimentPct(sentiment(10, 5, 0), 15),
    0,
  )
})
