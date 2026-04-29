import { describe, it } from "node:test"
import * as assert from "node:assert"
import {
  TOPIC_REVIEW_REASON_CODES,
  TOPIC_REVIEW_SUGGESTED_ACTIONS,
  TOPIC_REVIEW_SUGGESTED_LAYERS,
  TOPIC_REVIEW_STATUSES,
} from "../lib/admin/topic-review.ts"

// Contract test: verify that the enum lists match the CHECK constraints
// in scripts/031_topic_review_events.sql. The DB and the app must never
// drift — a new reason_code added in SQL must also be added here, and vice
// versa.
//
// This test is aspirational: it runs against the constant lists but doesn't
// actually query the live DB to compare against the CHECK constraints
// (that would require a Supabase instance in CI). When you add a code to
// 031_topic_review_events.sql, update the corresponding list here.

describe("topic review contract", () => {
  it("reason codes are sorted and non-empty", () => {
    assert.ok(TOPIC_REVIEW_REASON_CODES.length > 0)
    const sorted = [...TOPIC_REVIEW_REASON_CODES].sort()
    assert.deepStrictEqual(
      Array.from(TOPIC_REVIEW_REASON_CODES),
      sorted,
      "reason codes should be in alphabetical order for consistency",
    )
  })

  it("suggested layers are sorted and non-empty", () => {
    assert.ok(TOPIC_REVIEW_SUGGESTED_LAYERS.length > 0)
    const sorted = [...TOPIC_REVIEW_SUGGESTED_LAYERS].sort()
    assert.deepStrictEqual(
      Array.from(TOPIC_REVIEW_SUGGESTED_LAYERS),
      sorted,
      "suggested layers should be in alphabetical order for consistency",
    )
  })

  it("suggested actions are sorted and non-empty", () => {
    assert.ok(TOPIC_REVIEW_SUGGESTED_ACTIONS.length > 0)
    const sorted = [...TOPIC_REVIEW_SUGGESTED_ACTIONS].sort()
    assert.deepStrictEqual(
      Array.from(TOPIC_REVIEW_SUGGESTED_ACTIONS),
      sorted,
      "suggested actions should be in alphabetical order for consistency",
    )
  })

  it("statuses are sorted and non-empty", () => {
    assert.ok(TOPIC_REVIEW_STATUSES.length > 0)
    const sorted = [...TOPIC_REVIEW_STATUSES].sort()
    assert.deepStrictEqual(
      Array.from(TOPIC_REVIEW_STATUSES),
      sorted,
      "statuses should be in alphabetical order for consistency",
    )
  })

  it("no code appears in multiple lists", () => {
    const allCodes = [
      ...TOPIC_REVIEW_REASON_CODES,
      ...TOPIC_REVIEW_SUGGESTED_LAYERS,
      ...TOPIC_REVIEW_SUGGESTED_ACTIONS,
      ...TOPIC_REVIEW_STATUSES,
    ]
    const seen = new Set<string>()
    for (const code of allCodes) {
      if (seen.has(code)) {
        throw new Error(`Code "${code}" appears in multiple lists`)
      }
      seen.add(code)
    }
  })
})
