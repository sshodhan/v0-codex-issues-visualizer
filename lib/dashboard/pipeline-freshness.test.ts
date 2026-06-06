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
  const merged: PrerequisiteStatus = {
    observationsInWindow: 10,
    classifiedCount: 10,
    clusteredCount: 10,
    pendingClassification: 0,
    pendingClustering: 0,
    highImpactPendingClassification: 0,
    openaiConfigured: true,
    // 1 min before NOW — well inside any SLA.
    lastScrape: { at: "2026-04-24T11:59:00Z", status: "completed" },
    lastClassifyBackfill: { at: "2026-04-24T11:58:00Z", status: "completed" },
    ...overrides,
  }
  // Mirror the default from tests/classification-prerequisites.test.ts:
  // when a test bumps `pendingClassification` without specifying the
  // high-impact subset, assume every pending row is above threshold so
  // pre-threshold-gating tests keep producing the original CTA.
  if (overrides.highImpactPendingClassification === undefined) {
    merged.highImpactPendingClassification = merged.pendingClassification
  }
  return merged
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

test("pending classification stays healthy with informational subtext (no degraded nag)", () => {
  // Pending backlog is the steady state — the corpus is perpetually
  // behind on classification — so it surfaces as informational subtext
  // on a healthy strip rather than a degraded warning. Only staleness
  // (> 24h since last scrape) downgrades. See pipeline-freshness.ts:197.
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        classifiedCount: 5,
        pendingClassification: 5,
      }),
    }),
  )
  assert.equal(vm.state, "healthy")
  assert.equal(vm.reason, "all-caught-up")
  assert.equal(vm.cta, null, "healthy strip does not nag with a CTA")
  assert.match(vm.subtext ?? "", /5 awaiting classification/)
  // The ratio metric still flags attention so the number stays visible.
  assert.equal(vm.metrics.classified.status, "attention")
  assert.equal(vm.metrics.classified.value, "5 / 10 (50%)")
})

test("pending classification AND clustering both surface in informational subtext", () => {
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
  assert.equal(vm.state, "healthy")
  assert.equal(vm.reason, "all-caught-up")
  assert.match(vm.subtext ?? "", /6 awaiting classification/)
  assert.match(vm.subtext ?? "", /3 awaiting clustering/)
})

test("last classify-backfill failure is surfaced as a flag, not a degraded state", () => {
  // A failed backfill sets the flag (so the renderer can annotate the
  // classified metric) but no longer downgrades the whole strip — scrape
  // freshness is what governs healthy/degraded now.
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        lastClassifyBackfill: { at: "2026-04-24T11:00:00Z", status: "failed" },
      }),
    }),
  )
  assert.equal(vm.state, "healthy")
  assert.equal(vm.reason, "all-caught-up")
  assert.equal(vm.flags.lastClassifyBackfillFailed, true)
})

test("degraded path: stale last-scrape downgrades a caught-up pipeline", () => {
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        // ~28 hours ago — past the 1440-min (24h) default SLA.
        lastScrape: { at: "2026-04-23T08:00:00Z", status: "completed" },
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
  // NOTE: pending-classification, pending-clustering, and
  // classify-backfill-failed are deliberately NOT in this list. They now
  // surface as informational subtext on a *healthy* strip rather than as
  // non-healthy states (see pipeline-freshness.ts:197). Staleness is the
  // only backlog-adjacent signal that still downgrades.
  {
    name: "stale-scrape",
    inputs: () =>
      base({
        prereq: healthyPrereq({
          // ~28h ago — past the 24h freshness SLA.
          lastScrape: { at: "2026-04-23T08:00:00Z", status: "completed" },
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
      base({
        // Staleness (> 24h) is now the only path to `degraded`.
        prereq: healthyPrereq({
          lastScrape: { at: "2026-04-23T08:00:00Z", status: "completed" },
        }),
      }),
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

// --- Impact-threshold split ------------------------------------------------
// When `highImpactPendingClassification` differs from `pendingClassification`,
// the banner needs to surface both numbers AND the CTA behavior must match
// what the admin classify-backfill panel will actually do.

test("banner: when every pending row is below impact threshold, explain in informational subtext", () => {
  // Production repro: 110 awaiting classification, 0 high-impact. The
  // strip stays healthy (pending backlog is not a degraded state), but
  // the subtext names the below-threshold count so a reviewer
  // understands why the backfill panel reports "all caught up".
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        observationsInWindow: 113,
        classifiedCount: 3,
        pendingClassification: 110,
        highImpactPendingClassification: 0,
      }),
    }),
  )
  assert.equal(vm.state, "healthy")
  assert.equal(vm.reason, "all-caught-up")
  assert.match(
    vm.subtext ?? "",
    /110 previously classified below review threshold \(impact-\d+\)/,
  )
  assert.equal(vm.cta, null, "healthy strip does not nag with a CTA")
})

test("banner: when pending is split between high-impact and below-threshold, show both counts", () => {
  // 110 pending total, 6 high-impact. Subtext breaks out the 6
  // high-impact rows (reachable by backfill) from the 104 below-threshold
  // rows (not reachable without a policy change). Still a healthy strip.
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        observationsInWindow: 113,
        classifiedCount: 3,
        pendingClassification: 110,
        highImpactPendingClassification: 6,
      }),
    }),
  )
  assert.equal(vm.state, "healthy")
  assert.match(vm.subtext ?? "", /6 awaiting classification/)
  assert.match(
    vm.subtext ?? "",
    /104 previously classified below review threshold \(impact-\d+\)/,
  )
})

test("banner: when high-impact and total pending match, copy stays single-number (no regression)", () => {
  // All 5 pending rows are high-impact → no reason to clutter the
  // banner with "(5 high-impact)". This preserves the pre-split copy.
  const vm = derivePipelineFreshness(
    base({
      prereq: healthyPrereq({
        classifiedCount: 5,
        pendingClassification: 5,
        // highImpactPendingClassification defaulted to 5 via healthyPrereq
      }),
    }),
  )
  assert.match(vm.subtext ?? "", /5 awaiting classification/)
  assert.doesNotMatch(vm.subtext ?? "", /high-impact/)
  assert.doesNotMatch(vm.subtext ?? "", /below impact/)
})
