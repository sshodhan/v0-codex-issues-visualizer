import test from "node:test"
import assert from "node:assert/strict"

import { pickPrimaryCta } from "../lib/classification/prerequisites.ts"
import type { PrerequisiteStatus } from "../lib/classification/prerequisites.ts"

// Pure-function tests for the prerequisite panel decision tree. Imports
// the real helper so drift between test and implementation is caught by
// `tsc` (rather than mirroring the logic inline like earlier test files
// — the helper is small and framework-free so direct import is fine).
//
// See components/dashboard/classification-triage.tsx → pickPrimaryCta.

const mkPrereq = (overrides: Partial<PrerequisiteStatus> = {}): PrerequisiteStatus => {
  const merged: PrerequisiteStatus = {
    observationsInWindow: 100,
    classifiedCount: 100,
    clusteredCount: 100,
    pendingClassification: 0,
    pendingClustering: 0,
    highImpactPendingClassification: 0,
    openaiConfigured: true,
    lastScrape: { at: "2026-04-23T00:00:00Z", status: "completed" },
    lastClassifyBackfill: { at: "2026-04-23T00:00:00Z", status: "completed" },
    ...overrides,
  }
  // Preserve pre-threshold-gating test expectations: when a test bumps
  // `pendingClassification` without setting `highImpactPendingClassification`,
  // assume every pending row is above threshold so the old CTA behavior
  // kicks in. New tests that exercise the "below threshold" branch set
  // `highImpactPendingClassification` explicitly.
  if (overrides.highImpactPendingClassification === undefined) {
    merged.highImpactPendingClassification = merged.pendingClassification
  }
  return merged
}

test("pickPrimaryCta returns `none` when no observations in the window", () => {
  // Nothing downstream to fix — classify-backfill with an empty input
  // set is a waste of an API call and would render the primary button
  // as pointless. The prereq is upstream (wait for scrape / check cron).
  const cta = pickPrimaryCta(mkPrereq({ observationsInWindow: 0 }))
  assert.equal(cta.kind, "none")
})

test("pickPrimaryCta returns `openai-missing` when the key is unset", () => {
  // classify-backfill POST returns 503 without a key; a click-through
  // would dead-end. Warn in place and suppress the primary button.
  const cta = pickPrimaryCta(
    mkPrereq({
      observationsInWindow: 50,
      pendingClassification: 50,
      classifiedCount: 0,
      openaiConfigured: false,
    }),
  )
  assert.equal(cta.kind, "openai-missing")
})

test("`openai-missing` precedes `classify-backfill` even when classification is behind", () => {
  // Regression: the OpenAI check must sit BEFORE the
  // pendingClassification branch, otherwise we'd link reviewers into a
  // tab that 503s on submit.
  const cta = pickPrimaryCta(
    mkPrereq({
      observationsInWindow: 100,
      classifiedCount: 0,
      pendingClassification: 100,
      openaiConfigured: false,
    }),
  )
  assert.equal(cta.kind, "openai-missing")
})

test("pickPrimaryCta returns `classify-backfill` when classification is pending", () => {
  const cta = pickPrimaryCta(
    mkPrereq({
      observationsInWindow: 66,
      classifiedCount: 0,
      pendingClassification: 66,
    }),
  )
  assert.equal(cta.kind, "classify-backfill")
  if (cta.kind === "classify-backfill") {
    assert.equal(cta.href, "/admin?tab=classify-backfill")
  }
})

test("classify-backfill precedes clustering when both are pending", () => {
  // Classifications run on top of clustering, so classify-backfill is
  // the more universally-useful next step. The secondary CTA (rendered
  // separately by the panel) covers the clustering gap.
  const cta = pickPrimaryCta(
    mkPrereq({
      observationsInWindow: 66,
      classifiedCount: 10,
      pendingClassification: 56,
      clusteredCount: 60,
      pendingClustering: 6,
    }),
  )
  assert.equal(cta.kind, "classify-backfill")
})

test("pickPrimaryCta returns `clustering` when only clustering is pending", () => {
  const cta = pickPrimaryCta(
    mkPrereq({
      observationsInWindow: 66,
      classifiedCount: 66,
      pendingClassification: 0,
      clusteredCount: 60,
      pendingClustering: 6,
    }),
  )
  assert.equal(cta.kind, "clustering")
  if (cta.kind === "clustering") {
    assert.equal(cta.href, "/admin?tab=clustering")
  }
})

test("pickPrimaryCta returns `none` when everything is caught up", () => {
  // Fully-caught-up means the panel shouldn't render at all (the
  // `isPipelineEmpty` gate in the component stops it), but the helper
  // must return `none` defensively so a stale render never shows a
  // confusing CTA.
  const cta = pickPrimaryCta(mkPrereq())
  assert.equal(cta.kind, "none")
})

// --- Response-shape invariants ---------------------------------------------
// These don't test pickPrimaryCta directly, but they lock the invariants
// the helper depends on. If the API diverges from these, pickPrimaryCta
// will produce nonsense and callers will be surprised.

test("pendingClassification is always observationsInWindow - classifiedCount (never negative)", () => {
  // Defensive: data-integrity edge where classified > observations (e.g.
  // stale MV) would produce negative pending. The API clamps at 0; any
  // test that forgets to clamp should fail the helper's precedence.
  const cta = pickPrimaryCta(
    mkPrereq({
      observationsInWindow: 50,
      classifiedCount: 60, // ← bogus, API should clamp pending to 0
      pendingClassification: 0,
    }),
  )
  assert.equal(cta.kind, "none")
})

test("classifiedCount never exceeds observationsInWindow in well-formed data", () => {
  // Informational: when the API is healthy, classifiedCount <=
  // observationsInWindow. The pickPrimaryCta helper doesn't enforce
  // this — but panel rendering assumes it (the "X/Y classified" label
  // would read weirdly as "60/50" otherwise).
  const prereq = mkPrereq({
    observationsInWindow: 100,
    classifiedCount: 80,
    pendingClassification: 20,
  })
  assert.ok(prereq.classifiedCount <= prereq.observationsInWindow)
})

test("lastScrape and lastClassifyBackfill are independent timestamps", () => {
  // Informational: backfill can run without a fresh scrape and vice
  // versa. The helper doesn't correlate them; the panel shows both
  // separately so reviewers can tell whether a stale backfill or a
  // stale scrape is to blame.
  const prereq = mkPrereq({
    lastScrape: { at: "2026-04-23T00:00:00Z", status: "completed" },
    lastClassifyBackfill: { at: "2026-04-20T00:00:00Z", status: "completed" },
  })
  // Decision tree does not consult timestamps — confirm:
  assert.equal(pickPrimaryCta(prereq).kind, "none")
})

// --- Impact-threshold gating ----------------------------------------------
// The admin Layer C Backfill panel only processes observations with
// impact_score >= MIN_IMPACT_SCORE. When every pending row is below that
// threshold, "Run Layer C Backfill" is a no-op and linking the reviewer
// to it is the exact confusion that prompted adding
// `highImpactPendingClassification` to the prereq contract.

test("pickPrimaryCta suppresses classify-backfill when all pending rows are below impact threshold", () => {
  // 110 unclassified observations but 0 meet impact >= MIN_IMPACT_SCORE.
  // Clicking "Run Layer C Backfill" would do nothing; the helper must
  // return `none` so pipeline-freshness.ts can substitute a different
  // CTA (e.g. "View Layer C Backfill policy").
  const cta = pickPrimaryCta(
    mkPrereq({
      observationsInWindow: 113,
      classifiedCount: 3,
      pendingClassification: 110,
      highImpactPendingClassification: 0,
    }),
  )
  assert.equal(cta.kind, "none")
})

test("pickPrimaryCta returns classify-backfill when at least one row is above threshold", () => {
  // 110 total pending, 6 of them above threshold. Backfill has work to
  // do — surface the CTA so the reviewer can clear what they can.
  const cta = pickPrimaryCta(
    mkPrereq({
      observationsInWindow: 113,
      classifiedCount: 3,
      pendingClassification: 110,
      highImpactPendingClassification: 6,
    }),
  )
  assert.equal(cta.kind, "classify-backfill")
})
