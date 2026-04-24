import assert from "node:assert/strict"
import { test } from "node:test"
import {
  derivePipelineFreshness,
  type PipelineFreshnessInputs,
} from "./pipeline-freshness.ts"
import type { PrerequisiteStatus } from "../classification/prerequisites.ts"

// Fixed "now" so freshness-SLA assertions don't flake on CI.
const NOW = new Date("2026-04-24T12:00:00Z")
const fixedNow = () => NOW

function healthyPrereq(overrides: Partial<PrerequisiteStatus> = {}): PrerequisiteStatus {
  return {
    observationsInWindow: 10,
    classifiedCount: 10,
    clusteredCount: 10,
    pendingClassification: 0,
    pendingClustering: 0,
    openaiConfigured: true,
    // 1 min before NOW — well inside any SLA.
    lastScrape: { at: "2026-04-24T11:59:00Z", status: "completed" },
    lastClassifyBackfill: { at: "2026-04-24T11:58:00Z", status: "completed" },
    ...overrides,
  }
}

function base(overrides: Partial<PipelineFreshnessInputs> = {}): PipelineFreshnessInputs {
  return {
    prereq: healthyPrereq(),
    pendingReviewCount: 0,
    statsError: false,
    windowLabel: "Last 30 days",
    formatTimestamp: (iso: string) => `formatted:${iso}`,
    now: fixedNow,
    ...overrides,
  }
}

test("healthy path: caught-up pipeline with fresh scrape returns healthy/all-caught-up", () => {
  const vm = derivePipelineFreshness(base())
  assert.equal(vm.state, "healthy")
  assert.equal(vm.reason, "all-caught-up")
  assert.equal(vm.cta, null)
  assert.equal(vm.metrics.classified.status, "ok")
  assert.equal(vm.metrics.clustered.status, "ok")
  assert.equal(vm.metrics.classified.value, "10 / 10 (100%)")
})

test("empty path: 0 observations but pipeline caught up — distinguishes 'no issues' from 'behind'", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({ observationsInWindow: 0, classifiedCount: 0, clusteredCount: 0 }),
    }),
  )
  assert.equal(vm.state, "empty")
  assert.equal(vm.reason, "no-observations-in-window")
  assert.match(vm.headline, /No issues/i)
  assert.notEqual(vm.state, "healthy", "empty is a separate state from healthy")
  // Ratio denominator of 0 must not render as 100%.
  assert.equal(vm.metrics.classified.value, "0 / 0")
  assert.equal(vm.metrics.classified.status, "unknown")
})

test("degraded path: pending classification surfaces the classify-backfill CTA", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        classifiedCount: 5,
        pendingClassification: 5,
      }),
    }),
  )
  assert.equal(vm.state, "degraded")
  assert.equal(vm.reason, "pending-classification")
  assert.ok(vm.cta, "degraded path must surface a CTA")
  assert.match(vm.cta!.href, /classify-backfill/)
  assert.equal(vm.metrics.classified.status, "attention")
  assert.equal(vm.metrics.classified.value, "5 / 10 (50%)")
})

test("degraded path: pending classification AND clustering marks reason accordingly", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        classifiedCount: 4,
        clusteredCount: 7,
        pendingClassification: 6,
        pendingClustering: 3,
      }),
    }),
  )
  assert.equal(vm.state, "degraded")
  assert.equal(vm.reason, "pending-classification-and-clustering")
})

test("degraded path: last classify-backfill failed is surfaced as a flag + reason", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        lastClassifyBackfill: { at: "2026-04-24T11:00:00Z", status: "failed" },
      }),
    }),
  )
  assert.equal(vm.state, "degraded")
  assert.equal(vm.reason, "classify-backfill-failed")
  assert.equal(vm.flags.lastClassifyBackfillFailed, true)
})

test("degraded path: stale last-scrape downgrades a caught-up pipeline", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        // 3 hours ago — well past the 120-min default SLA.
        lastScrape: { at: "2026-04-24T09:00:00Z", status: "completed" },
      }),
    }),
  )
  assert.equal(vm.state, "degraded")
  assert.match(vm.headline, /stale/i)
})

test("failure path: last scrape failed overrides everything downstream", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        lastScrape: { at: "2026-04-24T11:00:00Z", status: "failed" },
      }),
    }),
  )
  assert.equal(vm.state, "failure")
  assert.equal(vm.reason, "last-scrape-failed")
})

test("failure path: OpenAI key missing with observations present", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({ openaiConfigured: false }),
    }),
  )
  assert.equal(vm.state, "failure")
  assert.equal(vm.reason, "openai-key-missing")
})

test("failure path: statsError outranks everything else and renders failure even when prereq looks healthy", () => {
  const vm = derivePipelineFreshness(base({ statsError: true }))
  assert.equal(vm.state, "failure")
  assert.equal(vm.reason, "stats-endpoint-errored")
})

test("unknown path: prereq undefined (still loading) renders 'loading', not healthy", () => {
  const vm = derivePipelineFreshness(
    base({ prereq: undefined, pendingReviewCount: undefined }),
  )
  assert.equal(vm.state, "unknown")
  assert.equal(vm.reason, "loading")
  // Critical: never default to "100%" or other healthy-looking values.
  assert.equal(vm.metrics.classified.value, null)
  assert.equal(vm.metrics.clustered.value, null)
  assert.equal(vm.metrics.pendingReview.value, null)
  assert.equal(vm.metrics.classified.status, "unknown")
})

test("unknown path: prereq null (server returned no prereq block) is still 'unknown', not healthy", () => {
  const vm = derivePipelineFreshness(base({ prereq: null }))
  assert.equal(vm.state, "unknown")
  assert.equal(vm.reason, "prereq-null")
  assert.ok(vm.cta, "null prereq offers /admin as a CTA so the reviewer can investigate")
})

test("pending review count: undefined renders as null (no silent zero)", () => {
  const vm = derivePipelineFreshness(base({ pendingReviewCount: undefined }))
  assert.equal(vm.metrics.pendingReview.value, null)
  assert.equal(vm.metrics.pendingReview.status, "unknown")
})

test("pending review count: positive integer flags attention", () => {
  const vm = derivePipelineFreshness(base({ pendingReviewCount: 3 }))
  assert.equal(vm.metrics.pendingReview.value, "3 high-impact")
  assert.equal(vm.metrics.pendingReview.status, "attention")
})

test("state machine is deterministic: same inputs produce the same view model", () => {
  const a = derivePipelineFreshness(base())
  const b = derivePipelineFreshness(base())
  assert.deepEqual(a, b)
})

test("precedence: statsError beats stale scrape beats pending backlog", () => {
  const prereq = healthyPrereq({
    lastScrape: { at: "2026-04-24T09:00:00Z", status: "failed" },
    pendingClassification: 5,
    classifiedCount: 5,
  })
  const vm = derivePipelineFreshness(base({ prereq, statsError: true }))
  assert.equal(vm.state, "failure")
  assert.equal(vm.reason, "stats-endpoint-errored")
})
