import test from "node:test"
import assert from "node:assert/strict"

import {
  MIN_IMPACT_SCORE,
  clampMinImpact,
} from "../lib/classification/run-backfill-constants.ts"

// The admin panel lets operators lower the impact-score threshold to
// preview what a more permissive classify-backfill policy would pick
// up. The helper that accepts the override must clamp the input
// defensively so no request ever reaches the DB query with a value
// outside the documented 0..10 range.

test("clampMinImpact returns the default when input is undefined", () => {
  // The daily cron and the dashboard-banner path both hit this branch —
  // they never pass an override, and must get the policy default.
  assert.equal(clampMinImpact(undefined), MIN_IMPACT_SCORE)
})

test("clampMinImpact returns the default when input is null", () => {
  assert.equal(clampMinImpact(null), MIN_IMPACT_SCORE)
})

test("clampMinImpact returns the default when input is NaN", () => {
  assert.equal(clampMinImpact(Number.NaN), MIN_IMPACT_SCORE)
})

test("clampMinImpact returns the default when input is Infinity", () => {
  assert.equal(clampMinImpact(Number.POSITIVE_INFINITY), MIN_IMPACT_SCORE)
  assert.equal(clampMinImpact(Number.NEGATIVE_INFINITY), MIN_IMPACT_SCORE)
})

test("clampMinImpact clamps negative inputs to 0", () => {
  // Operator typos "-5" — we don't want that to pass through as an
  // always-true filter. 0 is the most permissive legal value.
  assert.equal(clampMinImpact(-5), 0)
  assert.equal(clampMinImpact(-0.1), 0)
})

test("clampMinImpact clamps inputs above 10 to 10", () => {
  // Impact score is on a 0..10 scale. A threshold above the max is
  // nonsense — clamp so the query still executes with a valid filter.
  assert.equal(clampMinImpact(11), 10)
  assert.equal(clampMinImpact(100), 10)
})

test("clampMinImpact rounds to one decimal place", () => {
  // Impact scores have one-decimal precision (see docs/SCORING.md).
  // Thresholds must match so a "4.84" input doesn't silently exclude
  // rows that scored exactly 4.8.
  assert.equal(clampMinImpact(4.84), 4.8)
  assert.equal(clampMinImpact(4.85), 4.9)
  assert.equal(clampMinImpact(6.12), 6.1)
})

test("clampMinImpact preserves exact integer and one-decimal values", () => {
  assert.equal(clampMinImpact(0), 0)
  assert.equal(clampMinImpact(6), 6)
  assert.equal(clampMinImpact(10), 10)
  assert.equal(clampMinImpact(4.8), 4.8)
  assert.equal(clampMinImpact(MIN_IMPACT_SCORE), MIN_IMPACT_SCORE)
})
