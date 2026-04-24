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

// Invariant battery. These run over every non-healthy scenario and
// assert contracts the renderer relies on — the prompt's core rule is
// "never render a healthy-looking surface when inputs aren't healthy",
// which is a property check, not a single-path test.

const NON_HEALTHY_SCENARIOS: Array<{
  name: string
  inputs: () => PipelineFreshnessInputs
}> = [
  { name: "statsError", inputs: () => base({ statsError: true }) },
  { name: "prereq-undefined", inputs: () => base({ prereq: undefined }) },
  { name: "prereq-null", inputs: () => base({ prereq: null }) },
  {
    name: "last-scrape-failed",
    inputs: () =>
      base({
        prereq: healthyPrereq({
          lastScrape: { at: "2026-04-24T11:00:00Z", status: "failed" },
        }),
      }),
  },
  {
    name: "openai-missing-with-observations",
    inputs: () => base({ prereq: healthyPrereq({ openaiConfigured: false }) }),
  },
  {
    name: "pending-classification",
    inputs: () =>
      base({
        prereq: healthyPrereq({ classifiedCount: 4, pendingClassification: 6 }),
      }),
  },
  {
    name: "pending-clustering",
    inputs: () =>
      base({
        prereq: healthyPrereq({ clusteredCount: 3, pendingClustering: 7 }),
      }),
  },
  {
    name: "classify-backfill-failed",
    inputs: () =>
      base({
        prereq: healthyPrereq({
          lastClassifyBackfill: { at: "2026-04-24T11:00:00Z", status: "failed" },
        }),
      }),
  },
  {
    name: "stale-scrape",
    inputs: () =>
      base({
        prereq: healthyPrereq({
          lastScrape: { at: "2026-04-24T08:00:00Z", status: "completed" },
        }),
      }),
  },
]

test("invariant: non-healthy scenarios never return state=healthy", () => {
  for (const { name, inputs } of NON_HEALTHY_SCENARIOS) {
    const vm = derivePipelineFreshness(inputs())
    assert.notEqual(
      vm.state,
      "healthy",
      `${name} must not surface as healthy (got state=${vm.state}, reason=${vm.reason})`,
    )
  }
})

test("invariant: every view model has a non-empty headline", () => {
  const scenarios = [
    () => base(),
    () =>
      base({
        prereq: healthyPrereq({ observationsInWindow: 0, classifiedCount: 0, clusteredCount: 0 }),
      }),
    ...NON_HEALTHY_SCENARIOS.map((s) => s.inputs),
  ]
  for (const scenario of scenarios) {
    const vm = derivePipelineFreshness(scenario())
    assert.ok(
      vm.headline.length > 0,
      `headline must be non-empty for state=${vm.state} reason=${vm.reason}`,
    )
  }
})

test("invariant: failure and degraded states surface a CTA unless the reason is openai-missing-without-observations", () => {
  // openai-missing only matters when observations exist; without data
  // the openaiConfigured branch isn't reachable. We exclude that edge
  // case from the invariant.
  for (const { name, inputs } of NON_HEALTHY_SCENARIOS) {
    const vm = derivePipelineFreshness(inputs())
    if (vm.state === "failure" || vm.state === "degraded") {
      assert.ok(vm.cta, `${name} (state=${vm.state}) expected to expose a CTA`)
      assert.ok(vm.cta!.href.length > 0, `${name}: CTA href must be non-empty`)
      assert.ok(vm.cta!.label.length > 0, `${name}: CTA label must be non-empty`)
    }
  }
})

test("invariant: healthy state never exposes a CTA (caught up = no nag)", () => {
  const vm = derivePipelineFreshness(base())
  assert.equal(vm.state, "healthy")
  assert.equal(vm.cta, null)
})

test("invariant: loading/unknown never emit a ratio string that could look healthy", () => {
  const loading = derivePipelineFreshness(
    base({ prereq: undefined, pendingReviewCount: undefined }),
  )
  const nullPrereq = derivePipelineFreshness(base({ prereq: null, pendingReviewCount: undefined }))
  for (const vm of [loading, nullPrereq]) {
    assert.equal(vm.metrics.classified.value, null)
    assert.equal(vm.metrics.clustered.value, null)
    assert.equal(vm.metrics.pendingReview.value, null)
    // No healthy-looking "100%" strings.
    assert.equal(vm.metrics.classified.status, "unknown")
    assert.equal(vm.metrics.clustered.status, "unknown")
  }
})

test("invariant: ratios with total=0 render as '0 / 0' (never as 100%)", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        observationsInWindow: 0,
        classifiedCount: 0,
        clusteredCount: 0,
      }),
    }),
  )
  assert.equal(vm.metrics.classified.value, "0 / 0")
  assert.equal(vm.metrics.clustered.value, "0 / 0")
  assert.equal(vm.metrics.classified.status, "unknown")
})

test("invariant: all five legal states are reachable via the public input surface", () => {
  const reached = new Set<string>()
  reached.add(derivePipelineFreshness(base()).state) // healthy
  reached.add(
    derivePipelineFreshness(
      base({
        prereq: healthyPrereq({ observationsInWindow: 0, classifiedCount: 0, clusteredCount: 0 }),
      }),
    ).state,
  ) // empty
  reached.add(
    derivePipelineFreshness(
      base({ prereq: healthyPrereq({ classifiedCount: 4, pendingClassification: 6 }) }),
    ).state,
  ) // degraded
  reached.add(
    derivePipelineFreshness(
      base({
        prereq: healthyPrereq({
          lastScrape: { at: "2026-04-24T10:00:00Z", status: "failed" },
        }),
      }),
    ).state,
  ) // failure
  reached.add(derivePipelineFreshness(base({ prereq: undefined })).state) // unknown

  assert.deepEqual(
    Array.from(reached).sort(),
    ["degraded", "empty", "failure", "healthy", "unknown"].sort(),
  )
})

test("invariant: reason code stays within the documented enum", () => {
  const allowed = new Set([
    "loading",
    "stats-endpoint-errored",
    "prereq-null",
    "last-scrape-failed",
    "openai-key-missing",
    "classify-backfill-failed",
    "pending-classification",
    "pending-clustering",
    "pending-classification-and-clustering",
    "no-observations-in-window",
    "all-caught-up",
  ])
  const scenarios = [
    () => base(),
    () =>
      base({
        prereq: healthyPrereq({ observationsInWindow: 0, classifiedCount: 0, clusteredCount: 0 }),
      }),
    ...NON_HEALTHY_SCENARIOS.map((s) => s.inputs),
  ]
  for (const scenario of scenarios) {
    const vm = derivePipelineFreshness(scenario())
    assert.ok(
      allowed.has(vm.reason),
      `reason '${vm.reason}' for state=${vm.state} is not in the documented enum`,
    )
  }
})

test("custom freshness SLA: a tighter SLA downgrades a pipeline that passes the default", () => {
  const prereq = healthyPrereq({
    // 30 min ago — fresh for the default 120-min SLA, stale for a 10-min SLA.
    lastScrape: { at: "2026-04-24T11:30:00Z", status: "completed" },
  })
  const defaultVm = derivePipelineFreshness(base({ prereq }))
  const tightVm = derivePipelineFreshness(base({ prereq, freshnessSlaMinutes: 10 }))
  assert.equal(defaultVm.state, "healthy")
  assert.equal(tightVm.state, "degraded")
  assert.match(tightVm.headline, /stale/i)
})

test("custom freshness SLA: disabling via very large SLA never triggers stale", () => {
  const prereq = healthyPrereq({
    // 1 week ago — definitely stale for the default, but not for a 1-year SLA.
    lastScrape: { at: "2026-04-17T12:00:00Z", status: "completed" },
  })
  const vm = derivePipelineFreshness(
    base({ prereq, freshnessSlaMinutes: 60 * 24 * 365 }),
  )
  assert.equal(vm.state, "healthy")
})

test("formatTimestamp is used for the last-scrape display value", () => {
  let received: string | null = null
  const vm = derivePipelineFreshness(
    base({
      formatTimestamp: (iso: string) => {
        received = iso
        return "CUSTOM_FORMAT"
      },
    }),
  )
  assert.equal(vm.metrics.lastScrape.value, "CUSTOM_FORMAT")
  assert.equal(received, "2026-04-24T11:59:00Z")
})
