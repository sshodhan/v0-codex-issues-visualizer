import test from "node:test"
import assert from "node:assert/strict"

import { deriveClusterSignalState } from "../lib/classification/cluster-signal-state.ts"

test("strong state requires high count, multi-source, and non-trivial regex coverage", () => {
  const vm = deriveClusterSignalState({
    count: 18,
    source_count: 3,
    regex_variants: [
      { kind: "err", value: "EPIPE" },
      { kind: "stack", value: "foo.ts:10" },
      { kind: "env", value: "linux" },
    ],
    cluster_path: "semantic",
    classified_share: 0.8,
    human_reviewed_share: 0.5,
  })

  assert.equal(vm.state, "strong")
  assert.equal(vm.suppressConfidentNarrative, false)
  assert.equal(vm.ctaHref, "family")
})

test("emerging state triggers on low/moderate count with surge", () => {
  const vm = deriveClusterSignalState({
    count: 7,
    source_count: 2,
    regex_variants: [{ kind: "err", value: "ETIMEDOUT" }],
    surge_delta_pct: 120,
    cluster_path: "semantic",
    classified_share: 0.6,
    human_reviewed_share: 0.3,
  })

  assert.equal(vm.state, "emerging")
  assert.equal(vm.suppressConfidentNarrative, false)
  assert.equal(vm.ctaHref, "triage")
})

test("uncertain state wins for fallback clusters with low evidence/review", () => {
  const vm = deriveClusterSignalState({
    count: 4,
    source_count: 1,
    regex_variants: [{ kind: "err", value: "unknown" }],
    cluster_path: "fallback",
    classified_share: 0.2,
    human_reviewed_share: 0,
  })

  assert.equal(vm.state, "uncertain")
  assert.equal(vm.suppressConfidentNarrative, true)
  assert.equal(vm.ctaHref, "triage")
})
