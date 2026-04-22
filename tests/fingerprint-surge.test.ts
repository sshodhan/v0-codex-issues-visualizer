import test from "node:test"
import assert from "node:assert/strict"

import {
  selectTopFingerprintSurges,
  type FingerprintSurgeAggregateRow,
} from "../lib/analytics/fingerprint-surge.ts"

// Covers the client-side projection that turns the raw output of the
// `fingerprint_surges` SQL function into what the FingerprintSurgeCard
// renders. Pure function, fixture-driven — no Supabase dependency.

test("selectTopFingerprintSurges ranks by delta desc, drops non-positive deltas, detects new_in_window", () => {
  const rows: FingerprintSurgeAggregateRow[] = [
    { error_code: "ENOENT", now_count: 18, prev_count: 2, delta: 16, sources: 3 },
    { error_code: "EACCES", now_count: 4, prev_count: 0, delta: 4, sources: 2 },
    { error_code: "ETIMEDOUT", now_count: 3, prev_count: 3, delta: 0, sources: 2 },
    { error_code: "EPIPE", now_count: 1, prev_count: 5, delta: -4, sources: 1 },
  ]

  const { surges, new_in_window } = selectTopFingerprintSurges(rows)

  // Stable (no delta <= 0) and correctly ordered.
  assert.equal(surges.length, 2)
  assert.equal(surges[0].error_code, "ENOENT")
  assert.equal(surges[1].error_code, "EACCES")

  // A fingerprint counts as new_in_window only when prev_count === 0.
  assert.deepEqual(new_in_window, [{ error_code: "EACCES", count: 4, sources: 2 }])
})

test("selectTopFingerprintSurges breaks delta ties by now_count desc", () => {
  const rows: FingerprintSurgeAggregateRow[] = [
    { error_code: "A", now_count: 5, prev_count: 4, delta: 1, sources: 1 },
    { error_code: "B", now_count: 12, prev_count: 11, delta: 1, sources: 2 },
  ]
  const { surges } = selectTopFingerprintSurges(rows)
  assert.equal(surges[0].error_code, "B")
  assert.equal(surges[1].error_code, "A")
})

test("selectTopFingerprintSurges caps output at 10", () => {
  const rows: FingerprintSurgeAggregateRow[] = Array.from({ length: 25 }, (_, i) => ({
    error_code: `CODE_${i.toString().padStart(2, "0")}`,
    now_count: 25 - i,
    prev_count: 0,
    delta: 25 - i,
    sources: 1,
  }))
  const { surges, new_in_window } = selectTopFingerprintSurges(rows)
  assert.equal(surges.length, 10)
  // new_in_window is uncapped (analysts want to see every new code) and
  // sorted by now_count desc.
  assert.equal(new_in_window.length, 25)
  assert.equal(new_in_window[0].count, 25)
})

test("selectTopFingerprintSurges returns empty shape when no positive-delta rows", () => {
  const rows: FingerprintSurgeAggregateRow[] = [
    { error_code: "STABLE", now_count: 3, prev_count: 3, delta: 0, sources: 1 },
  ]
  const { surges, new_in_window } = selectTopFingerprintSurges(rows)
  assert.equal(surges.length, 0)
  assert.equal(new_in_window.length, 0)
})
