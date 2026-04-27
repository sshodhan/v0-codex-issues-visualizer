import assert from "node:assert/strict"
import { test } from "node:test"
import { pickAtlasAnnotation } from "./atlas-annotation.ts"

test("returns null for empty input", () => {
  assert.equal(pickAtlasAnnotation([]), null)
})

test("returns null when total count is zero", () => {
  assert.equal(
    pickAtlasAnnotation([
      { name: "Bug", count: 0 },
      { name: "API", count: 0 },
    ]),
    null,
  )
})

test("returns null when no category is dominant enough (share < 30% AND lead < 1.4×)", () => {
  // Five categories at 20% each — flat distribution, no story.
  const out = pickAtlasAnnotation([
    { name: "A", count: 10 },
    { name: "B", count: 10 },
    { name: "C", count: 10 },
    { name: "D", count: 10 },
    { name: "E", count: 10 },
  ])
  assert.equal(out, null)
})

test("returns the top category when share ≥ 30%", () => {
  // Bug = 50%, well over the 30% floor.
  const out = pickAtlasAnnotation([
    { name: "Bug", count: 50, color: "#ef4444" },
    { name: "API", count: 30 },
    { name: "Performance", count: 20 },
  ])
  assert.ok(out)
  assert.equal(out!.label, "Bug")
  assert.equal(out!.count, 50)
  assert.equal(Math.round(out!.share * 100), 50)
  assert.equal(out!.color, "#ef4444")
})

test("returns the top category when lead is ≥ 1.4× even if share is below the floor", () => {
  // Top is 25% (under floor) but 5× the runner-up — clear leader.
  const out = pickAtlasAnnotation([
    { name: "Top", count: 25 },
    { name: "B", count: 5 },
    { name: "C", count: 5 },
    { name: "D", count: 5 },
    { name: "E", count: 5 },
    { name: "F", count: 5 },
    { name: "G", count: 5 },
    { name: "H", count: 5 },
    { name: "I", count: 5 },
    { name: "J", count: 5 },
    { name: "K", count: 5 },
    { name: "L", count: 5 },
    { name: "M", count: 5 },
    { name: "N", count: 5 },
    { name: "O", count: 5 },
  ])
  assert.ok(out)
  assert.equal(out!.label, "Top")
})

test("respects custom minShare / minLeadOverSecond thresholds", () => {
  // 20% share, 2× lead → qualifies under default lead threshold.
  // But with minLeadOverSecond=2.5 and minShare=0.4, neither qualifies.
  const rows = [
    { name: "Top", count: 20 },
    { name: "B", count: 10 },
    { name: "C", count: 10 },
    { name: "D", count: 10 },
    { name: "E", count: 10 },
    { name: "F", count: 10 },
    { name: "G", count: 10 },
    { name: "H", count: 10 },
    { name: "I", count: 10 },
  ]
  const lax = pickAtlasAnnotation(rows)
  assert.ok(lax)
  const strict = pickAtlasAnnotation(rows, { minShare: 0.4, minLeadOverSecond: 2.5 })
  assert.equal(strict, null)
})

test("uses provided slug when supplied; otherwise hyphenates the name", () => {
  const withSlug = pickAtlasAnnotation([{ name: "Tool Errors", slug: "tool_errors", count: 10 }])
  assert.equal(withSlug!.slug, "tool_errors")
  const withoutSlug = pickAtlasAnnotation([{ name: "Feature Request", count: 10 }])
  assert.equal(withoutSlug!.slug, "feature-request")
})

test("ignores zero / negative counts when computing the leader", () => {
  // Zero-count rows shouldn't poison total or short-circuit.
  const out = pickAtlasAnnotation([
    { name: "Zero", count: 0 },
    { name: "Lead", count: 30 },
    { name: "Other", count: 10 },
  ])
  assert.ok(out)
  assert.equal(out!.label, "Lead")
})

test("deterministic: same input always picks the same row", () => {
  const rows = [
    { name: "Bug", count: 50 },
    { name: "API", count: 20 },
  ]
  const a = pickAtlasAnnotation(rows)
  const b = pickAtlasAnnotation(rows)
  assert.deepEqual(a, b)
})
