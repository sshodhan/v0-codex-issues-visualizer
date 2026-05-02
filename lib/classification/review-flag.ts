/**
 * Reviewer-flag computation.
 *
 * Single source of truth for "did a reviewer mark this LLM
 * classification as untrusted?". Used by both:
 *
 *   - Phase 2 admin metric (`app/api/admin/embedding-signal-coverage/route.ts`)
 *     to compute `with_review_flagged_llm_classification`.
 *   - Phase 4 production runtime (`lib/embeddings/v3-input-from-observation.ts`)
 *     to compute `review_flagged` for the v3 embedding helper's gate.
 *
 * Both consumers MUST go through this module so the computation stays
 * in lockstep with the definition. Adding a new reviewer state that
 * should also gate the LLM output means updating only the
 * `FLAGGED_REVIEW_STATUSES` set below; both call sites pick it up.
 *
 * Lives under `lib/classification/` (not `lib/embeddings/` or
 * `lib/admin/`) because the concept is "reviewer's verdict on a
 * classification" — a classification-layer concern even though the
 * primary consumers are downstream.
 */

/** Status values from `classification_reviews.status` that count as
 *  "review-flagged" — i.e., reviewer explicitly does not endorse the
 *  LLM output and downstream consumers should NOT use its taxonomy.
 *
 *  `classification_reviews.status` is `text` (no enum constraint), so
 *  the set of values that can land in this column is determined by
 *  the reviewer UI rather than the schema. The list below covers the
 *  documented review-decision states across reviewer flows:
 *    - `flagged` / `needs_review` — reviewer escalated for follow-up
 *    - `rejected` / `incorrect` / `invalid` — reviewer disagreed with
 *      the LLM's assignment
 *    - `unclear` — reviewer couldn't decide; treat as untrusted
 *  Approved/correct values are intentionally absent — those should
 *  let the LLM taxonomy through unchanged.
 *
 *  Operators verifying the live distribution can run:
 *    SELECT status, COUNT(*) FROM classification_reviews GROUP BY 1;
 *  If a reviewer state appears that should also gate the LLM output,
 *  add it here in one place — every consumer of `computeReviewFlagged`
 *  picks it up. */
export const FLAGGED_REVIEW_STATUSES = new Set<string>([
  "flagged",
  "needs_review",
  "rejected",
  "incorrect",
  "invalid",
  "unclear",
])

/** Shape of a `classification_reviews` row sufficient to compute
 *  the review-flagged signal. Both `status` and `needs_human_review`
 *  matter:
 *
 *    - `needs_human_review === true` is the strong signal — a reviewer
 *      explicitly asked for follow-up.
 *    - `status` in `FLAGGED_REVIEW_STATUSES` is the secondary signal —
 *      a reviewer recorded a verdict that doesn't endorse the LLM.
 *
 *  The function returns `true` when EITHER signal is set. A null /
 *  missing review row means "no reviewer has touched this" → not
 *  flagged. */
export interface ReviewFlagInputs {
  status?: string | null
  needs_human_review?: boolean | null
}

/** Compute the review-flagged boolean from a (possibly absent or
 *  partial) `classification_reviews` row. Same logic the Phase 2
 *  metric uses; same logic the Phase 4 production runtime uses. */
export function computeReviewFlagged(review?: ReviewFlagInputs | null): boolean {
  if (!review) return false
  if (review.needs_human_review === true) return true
  const statusLower = review.status?.toLowerCase().trim() ?? ""
  return statusLower !== "" && FLAGGED_REVIEW_STATUSES.has(statusLower)
}
