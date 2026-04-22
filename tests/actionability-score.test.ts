import test from "node:test"
import assert from "node:assert/strict"

import {
  computeActionability,
  computeActionabilityBreakdown,
} from "../lib/analytics/actionability.ts"

// Actionability score contract (docs/SCORING.md §10.1):
//   0.55*(impact/10) + 0.20*min(freq/10,1) + 0.10*(error_code?1:0)
// + 0.08*min(repro_markers/3,1) + 0.07*min(max(source_diversity-1,0)/3,1)
//
// Weights sum to 1.0. The score is always in [0,1].

test("high-impact GitHub ENOENT with repros beats 50-upvote Reddit no-code complaint", () => {
  // Golden case — the entire PR's reason for existing. A first-party
  // bug report that has a concrete error code, a three-step repro, and
  // confirmation from multiple sources must outrank a popular but
  // unactionable forum complaint.
  const githubBug = computeActionability({
    impact_score: 9,
    frequency_count: 6,
    error_code: "ENOENT",
    repro_markers: 3,
    source_diversity: 3,
  })
  const redditComplaint = computeActionability({
    impact_score: 7,
    frequency_count: 10,
    error_code: null,
    repro_markers: 0,
    source_diversity: 1,
  })

  assert.ok(
    githubBug > redditComplaint,
    `expected code-addressable row to outrank unsourced complaint (got ${githubBug} vs ${redditComplaint})`,
  )
})

test("score is bounded in [0, 1]", () => {
  const zero = computeActionability({
    impact_score: 0,
    frequency_count: 0,
    error_code: null,
    repro_markers: 0,
    source_diversity: 0,
  })
  assert.ok(zero >= 0 && zero <= 1)

  const max = computeActionability({
    impact_score: 10,
    frequency_count: 100,
    error_code: "ENOENT",
    repro_markers: 9,
    source_diversity: 10,
  })
  assert.ok(max >= 0 && max <= 1)
  // All terms at their cap → weights sum to 1.0.
  assert.equal(max, 1)
})

test("error_code adds exactly 0.10 at the margin", () => {
  const base = {
    impact_score: 5,
    frequency_count: 2,
    repro_markers: 0,
    source_diversity: 1,
  }
  const without = computeActionability({ ...base, error_code: null })
  const withCode = computeActionability({ ...base, error_code: "EACCES" })
  // Allow tolerance for the 4-decimal rounding in the helper.
  assert.ok(Math.abs((withCode - without) - 0.1) < 1e-6)
})

test("repro_markers clamp at 3 (08% weight is fully realized at marker count 3)", () => {
  const base = {
    impact_score: 4,
    frequency_count: 2,
    error_code: null,
    source_diversity: 1,
  }
  const three = computeActionability({ ...base, repro_markers: 3 })
  const ten = computeActionability({ ...base, repro_markers: 10 })
  assert.equal(three, ten)
})

test("source_diversity baseline 1 contributes 0; each source up to 4 adds a fraction of 7%", () => {
  const base = {
    impact_score: 3,
    frequency_count: 2,
    error_code: null,
    repro_markers: 0,
  }
  const single = computeActionability({ ...base, source_diversity: 1 })
  const four = computeActionability({ ...base, source_diversity: 4 })
  // 4 sources → (4-1)/3 = 1 → 0.07 bonus.
  assert.ok(Math.abs((four - single) - 0.07) < 1e-6)
})

test("null/undefined inputs coerce to 0 instead of NaN", () => {
  const score = computeActionability({
    impact_score: undefined as unknown as number,
    frequency_count: undefined as unknown as number,
    error_code: undefined,
    repro_markers: undefined,
    source_diversity: undefined,
  })
  assert.ok(Number.isFinite(score))
  assert.equal(score, 0)
})

test("computeActionabilityBreakdown terms sum to computeActionability (within rounding)", () => {
  const input = {
    impact_score: 8,
    frequency_count: 7,
    error_code: "ETIMEDOUT",
    repro_markers: 2,
    source_diversity: 3,
  }
  const total = computeActionability(input)
  const breakdown = computeActionabilityBreakdown(input)
  const sum =
    breakdown.impact +
    breakdown.frequency +
    breakdown.error_code +
    breakdown.repro_markers +
    breakdown.source_diversity
  // Both are 4-decimal-rounded — allow 2e-4 slack.
  assert.ok(Math.abs(total - sum) < 2e-4, `total=${total} sum=${sum}`)
})
