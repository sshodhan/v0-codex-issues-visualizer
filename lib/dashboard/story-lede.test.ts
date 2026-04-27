import assert from "node:assert/strict"
import { test } from "node:test"
import { computeStoryLede } from "./story-lede.ts"
import type { StoryTimelinePoint } from "./story-timeline.ts"

const DAY_MS = 86_400_000

function mkPoint(overrides: Partial<StoryTimelinePoint>): StoryTimelinePoint {
  return {
    id: overrides.id ?? "p",
    title: overrides.title ?? "t",
    url: overrides.url ?? "u",
    publishedAt: overrides.publishedAt ?? new Date().toISOString(),
    impact: overrides.impact ?? 1,
    tNorm: overrides.tNorm ?? 0.5,
    categoryName: overrides.categoryName ?? "Bug",
    categorySlug: overrides.categorySlug ?? "bug",
    categoryColor: overrides.categoryColor ?? "#ef4444",
    sourceSlug: overrides.sourceSlug ?? "github",
    errorCode: overrides.errorCode ?? null,
    clusterId: overrides.clusterId ?? null,
    rScale: overrides.rScale ?? 0.5,
  }
}

test("empty window returns kind=empty with helpful subhead", () => {
  const out = computeStoryLede([], { startMs: 0, endMs: DAY_MS * 7 })
  assert.equal(out.kind, "empty")
  assert.equal(out.total, 0)
  assert.match(out.headline, /No reports/)
  assert.ok(out.subhead && /widen/i.test(out.subhead))
})

test("quiet window (total < 5) frames as a quiet window, not a peak", () => {
  const start = new Date("2026-04-01T00:00:00Z").getTime()
  const end = start + DAY_MS * 7
  const out = computeStoryLede(
    [
      mkPoint({ id: "1", publishedAt: new Date(start + DAY_MS * 1).toISOString() }),
      mkPoint({ id: "2", publishedAt: new Date(start + DAY_MS * 3).toISOString() }),
    ],
    { startMs: start, endMs: end },
  )
  assert.equal(out.kind, "quiet")
  assert.equal(out.total, 2)
  assert.match(out.headline, /quiet/i)
})

test("peak day stands out → kind=peak, peakDayFrac matches the busy day", () => {
  const start = new Date("2026-04-20T00:00:00Z").getTime()
  const end = start + DAY_MS * 6
  // Apr 20 → 1, Apr 21 → 1, Apr 22 → 1, Apr 23 → 8 (peak), Apr 24 → 1, Apr 25 → 1
  const points: StoryTimelinePoint[] = []
  for (let day = 0; day < 6; day++) {
    const dayStart = start + DAY_MS * day
    const count = day === 3 ? 8 : 1
    for (let i = 0; i < count; i++) {
      points.push(
        mkPoint({
          id: `${day}-${i}`,
          publishedAt: new Date(dayStart + 12 * 3600 * 1000).toISOString(),
        }),
      )
    }
  }
  const out = computeStoryLede(points, { startMs: start, endMs: end })
  assert.equal(out.kind, "peak")
  assert.equal(out.peakCount, 8)
  // Peak day is Apr 23 — index 3 of 6 → midpoint frac ≈ 3.5/6 ≈ 0.583
  assert.ok(out.peakDayFrac! > 0.45 && out.peakDayFrac! < 0.7)
  assert.match(out.headline, /busiest day/)
})

test("strong period-over-period delta with no clear peak → kind=surge", () => {
  const start = new Date("2026-04-01T00:00:00Z").getTime()
  const end = start + DAY_MS * 14
  const points: StoryTimelinePoint[] = []
  // First half: 5 reports spread evenly
  for (let i = 0; i < 5; i++) {
    points.push(
      mkPoint({
        id: `prior-${i}`,
        publishedAt: new Date(start + DAY_MS * (i * 1.4)).toISOString(),
      }),
    )
  }
  // Second half: 15 reports spread evenly (3× growth, no single peak day)
  for (let i = 0; i < 15; i++) {
    points.push(
      mkPoint({
        id: `recent-${i}`,
        publishedAt: new Date(
          start + DAY_MS * 7 + DAY_MS * (i * 0.45),
        ).toISOString(),
      }),
    )
  }
  const out = computeStoryLede(points, { startMs: start, endMs: end })
  assert.equal(out.kind, "surge")
  assert.equal(out.recentCount, 15)
  assert.equal(out.priorCount, 5)
  assert.ok(out.deltaPct! > 100)
  assert.match(out.headline, /climbed/i)
})

test("dominant category is the most common on the peak day, not the window", () => {
  const start = new Date("2026-04-20T00:00:00Z").getTime()
  const end = start + DAY_MS * 5
  // Window-wide: Bug dominates with 4. But on peak day (Apr 23), Performance has 4.
  const points: StoryTimelinePoint[] = [
    mkPoint({ id: "b1", categoryName: "Bug", publishedAt: new Date(start + DAY_MS * 0 + 1).toISOString() }),
    mkPoint({ id: "b2", categoryName: "Bug", publishedAt: new Date(start + DAY_MS * 1 + 1).toISOString() }),
    mkPoint({ id: "b3", categoryName: "Bug", publishedAt: new Date(start + DAY_MS * 2 + 1).toISOString() }),
    mkPoint({ id: "b4", categoryName: "Bug", publishedAt: new Date(start + DAY_MS * 4 + 1).toISOString() }),
    // Apr 23 is index 3 from start
    mkPoint({ id: "p1", categoryName: "Performance", categoryColor: "#f59e0b", publishedAt: new Date(start + DAY_MS * 3 + 1).toISOString() }),
    mkPoint({ id: "p2", categoryName: "Performance", publishedAt: new Date(start + DAY_MS * 3 + 2).toISOString() }),
    mkPoint({ id: "p3", categoryName: "Performance", publishedAt: new Date(start + DAY_MS * 3 + 3).toISOString() }),
    mkPoint({ id: "p4", categoryName: "Performance", publishedAt: new Date(start + DAY_MS * 3 + 4).toISOString() }),
  ]
  const out = computeStoryLede(points, { startMs: start, endMs: end })
  assert.equal(out.kind, "peak")
  assert.equal(out.peakDominant?.name, "Performance")
  assert.equal(out.peakDominant?.count, 4)
})

test("invalid publishedAt strings are ignored, not crashed on", () => {
  const start = Date.now()
  const end = start + DAY_MS * 3
  const out = computeStoryLede(
    [
      mkPoint({ id: "good", publishedAt: new Date(start + 100).toISOString() }),
      mkPoint({ id: "bad", publishedAt: "not-a-date" }),
      mkPoint({ id: "blank", publishedAt: "" as unknown as string }),
    ],
    { startMs: start, endMs: end },
  )
  assert.ok(out.total >= 1)
  assert.ok(["peak", "quiet"].includes(out.kind))
})

test("computeStoryLede is deterministic on identical inputs", () => {
  const start = new Date("2026-04-10T00:00:00Z").getTime()
  const end = start + DAY_MS * 5
  const points = [
    mkPoint({ id: "a", publishedAt: new Date(start + DAY_MS * 1).toISOString() }),
    mkPoint({ id: "b", publishedAt: new Date(start + DAY_MS * 2).toISOString() }),
    mkPoint({
      id: "c",
      categoryName: "API",
      publishedAt: new Date(start + DAY_MS * 2 + 60_000).toISOString(),
    }),
  ]
  const a = computeStoryLede(points, { startMs: start, endMs: end })
  const b = computeStoryLede(points, { startMs: start, endMs: end })
  assert.deepEqual(a, b)
})
