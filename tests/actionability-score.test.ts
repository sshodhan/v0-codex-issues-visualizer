import test from "node:test"
import assert from "node:assert/strict"
import { computeActionability } from "../lib/analytics/actionability.ts"

test("actionability favors code-addressable, reproducible cluster", () => {
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

  assert.ok(githubBug > redditComplaint)
})
