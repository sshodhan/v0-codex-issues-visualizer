import test from "node:test"
import assert from "node:assert/strict"

import {
  composeDeterministicLabel,
  mode,
  topicNameForSlug,
} from "../lib/storage/cluster-label-fallback.ts"

test("topicNameForSlug returns canonical names for seed slugs", () => {
  assert.equal(topicNameForSlug("bug"), "Bug")
  assert.equal(topicNameForSlug("performance"), "Performance")
  assert.equal(topicNameForSlug("feature-request"), "Feature Request")
  assert.equal(topicNameForSlug("ux-ui"), "UX/UI")
  assert.equal(topicNameForSlug("api"), "API")
  assert.equal(topicNameForSlug("other"), "Other")
})

test("topicNameForSlug title-cases unknown slugs", () => {
  assert.equal(topicNameForSlug("release-notes"), "Release Notes")
  assert.equal(topicNameForSlug("billing"), "Billing")
  assert.equal(topicNameForSlug(null), null)
  assert.equal(topicNameForSlug(undefined), null)
  assert.equal(topicNameForSlug(""), null)
})

test("mode returns most frequent value, breaking ties lexicographically", () => {
  assert.equal(mode(["a", "a", "b"]), "a")
  assert.equal(mode(["a", "b", "b", "a"]), "a") // tie → ascending winner
  assert.equal(mode(["c", "b", "a"]), "a") // all 1 each → ascending winner
  assert.equal(mode([null, undefined, "x"]), "x")
  assert.equal(mode([null, undefined, null]), null)
  assert.equal(mode<string>([]), null)
})

test("composeDeterministicLabel uses topic + error code when both present", () => {
  const result = composeDeterministicLabel({
    topicSlugs: ["bug", "bug", "performance"],
    errorCodes: ["ENOENT", "ENOENT", "EACCES"],
    titles: ["a", "b"],
  })
  assert.equal(result.label, "Bug cluster · ENOENT")
  assert.equal(result.model, "deterministic:topic-and-error")
  assert.equal(result.confidence, 0.55)
  assert.match(result.rationale, /Bug.*ENOENT/)
})

test("composeDeterministicLabel falls back to topic only when no error code", () => {
  const result = composeDeterministicLabel({
    topicSlugs: ["performance", "performance", null],
    errorCodes: [null, null, null],
    titles: ["x"],
  })
  assert.equal(result.label, "Performance cluster")
  assert.equal(result.model, "deterministic:topic")
  assert.equal(result.confidence, 0.45)
})

test("composeDeterministicLabel falls back to error code only when no topic", () => {
  const result = composeDeterministicLabel({
    topicSlugs: [null, undefined],
    errorCodes: ["EACCES", "EACCES", null],
    titles: ["x"],
  })
  assert.equal(result.label, "EACCES cluster")
  assert.equal(result.model, "deterministic:error")
  assert.equal(result.confidence, 0.45)
})

test("composeDeterministicLabel falls back to shortest title when no signals", () => {
  const result = composeDeterministicLabel({
    topicSlugs: [null, null],
    errorCodes: [null, null],
    titles: ["A long incident title with many words", "Short crash"],
  })
  assert.equal(result.label, "Cluster · Short crash")
  assert.equal(result.model, "deterministic:title")
  assert.equal(result.confidence, 0.4)
})

test("composeDeterministicLabel truncates very long fallback titles", () => {
  const longTitle = "This is a really long single canonical title with no whitespace so we trim it"
  const result = composeDeterministicLabel({
    topicSlugs: [null],
    errorCodes: [null],
    titles: [longTitle],
  })
  assert.equal(result.model, "deterministic:title")
  assert.ok(result.label.startsWith("Cluster · "))
  assert.ok(result.label.endsWith("…"))
  assert.ok(result.label.length <= "Cluster · ".length + 60)
})

test("composeDeterministicLabel handles empty titles gracefully", () => {
  const result = composeDeterministicLabel({
    topicSlugs: [null],
    errorCodes: [null],
    titles: ["", "   "],
  })
  assert.equal(result.label, "Cluster · Unnamed cluster")
  assert.equal(result.model, "deterministic:title")
})

test("composeDeterministicLabel confidence always >= UI threshold (0.4)", () => {
  const cases = [
    { topicSlugs: ["bug"], errorCodes: ["X"], titles: ["t"] },
    { topicSlugs: ["bug"], errorCodes: [null], titles: ["t"] },
    { topicSlugs: [null], errorCodes: ["X"], titles: ["t"] },
    { topicSlugs: [null], errorCodes: [null], titles: ["t"] },
  ]
  for (const args of cases) {
    const result = composeDeterministicLabel(args)
    assert.ok(result.confidence >= 0.4, `confidence ${result.confidence} below UI threshold`)
  }
})
