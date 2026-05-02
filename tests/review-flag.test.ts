import test from "node:test"
import assert from "node:assert/strict"

import {
  FLAGGED_REVIEW_STATUSES,
  computeReviewFlagged,
} from "../lib/classification/review-flag.ts"

// ============================================================================
// Centralized review-flag computation. Both the Phase 2 admin metric
// (app/api/admin/embedding-signal-coverage/route.ts) and the Phase 4
// production runtime (lib/embeddings/v3-input-from-observation.ts)
// import this; tests below pin the contract those callers depend on.
// ============================================================================

test("FLAGGED_REVIEW_STATUSES contains all documented flagged states", () => {
  // The locked set. If you change this, update both:
  //   - the Phase 2 admin metric's "% review-flagged" expectation
  //   - the Phase 4 helper's gating policy
  // Test pins the membership so the change isn't silent.
  assert.equal(FLAGGED_REVIEW_STATUSES.size, 6)
  assert.ok(FLAGGED_REVIEW_STATUSES.has("flagged"))
  assert.ok(FLAGGED_REVIEW_STATUSES.has("needs_review"))
  assert.ok(FLAGGED_REVIEW_STATUSES.has("rejected"))
  assert.ok(FLAGGED_REVIEW_STATUSES.has("incorrect"))
  assert.ok(FLAGGED_REVIEW_STATUSES.has("invalid"))
  assert.ok(FLAGGED_REVIEW_STATUSES.has("unclear"))
})

test("FLAGGED_REVIEW_STATUSES does NOT contain approved/correct values", () => {
  // Approved values should let the LLM taxonomy through unchanged —
  // these MUST NOT be in the flagged set.
  assert.equal(FLAGGED_REVIEW_STATUSES.has("approved"), false)
  assert.equal(FLAGGED_REVIEW_STATUSES.has("correct"), false)
  assert.equal(FLAGGED_REVIEW_STATUSES.has("confirmed"), false)
  assert.equal(FLAGGED_REVIEW_STATUSES.has(""), false)
})

test("computeReviewFlagged: null/undefined review → false", () => {
  // No reviewer has touched this row → not flagged.
  assert.equal(computeReviewFlagged(null), false)
  assert.equal(computeReviewFlagged(undefined), false)
})

test("computeReviewFlagged: needs_human_review=true → flagged regardless of status", () => {
  // The strong signal — reviewer explicitly requested follow-up.
  assert.equal(
    computeReviewFlagged({ needs_human_review: true, status: null }),
    true,
  )
  assert.equal(
    computeReviewFlagged({ needs_human_review: true, status: "approved" }),
    true,
    "needs_human_review trumps approved status",
  )
})

test("computeReviewFlagged: status in FLAGGED_REVIEW_STATUSES → flagged", () => {
  for (const status of ["flagged", "needs_review", "rejected", "incorrect", "invalid", "unclear"]) {
    assert.equal(
      computeReviewFlagged({ status, needs_human_review: false }),
      true,
      `expected status="${status}" to be flagged`,
    )
  }
})

test("computeReviewFlagged: case-insensitive status matching", () => {
  // Reviewers may type any case; we lowercase for comparison.
  assert.equal(computeReviewFlagged({ status: "REJECTED" }), true)
  assert.equal(computeReviewFlagged({ status: "Flagged" }), true)
  assert.equal(computeReviewFlagged({ status: "  needs_review  " }), true)
})

test("computeReviewFlagged: approved/correct status → NOT flagged", () => {
  assert.equal(computeReviewFlagged({ status: "approved" }), false)
  assert.equal(computeReviewFlagged({ status: "correct" }), false)
  assert.equal(computeReviewFlagged({ status: "confirmed" }), false)
})

test("computeReviewFlagged: empty/whitespace status → NOT flagged (no signal)", () => {
  assert.equal(computeReviewFlagged({ status: "" }), false)
  assert.equal(computeReviewFlagged({ status: "   " }), false)
  assert.equal(computeReviewFlagged({ status: null }), false)
  assert.equal(computeReviewFlagged({ status: undefined }), false)
})

test("computeReviewFlagged: needs_human_review=false + status=null → NOT flagged", () => {
  // Empty review row exists but reviewer hasn't acted on either signal.
  assert.equal(
    computeReviewFlagged({ needs_human_review: false, status: null }),
    false,
  )
  assert.equal(computeReviewFlagged({}), false)
})
