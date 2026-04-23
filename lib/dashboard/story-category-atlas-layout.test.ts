import assert from "node:assert/strict"
import { test } from "node:test"
import { countBubbles } from "./story-category-atlas-layout.ts"

test("countBubbles is deterministic and scales by count", () => {
  const items = [
    { id: "a", label: "A", count: 10 },
    { id: "b", label: "B", count: 5 },
  ]
  const p1 = countBubbles(items, { minR: 10, maxR: 20, width: 200, height: 200 })
  const p2 = countBubbles(items, { minR: 10, maxR: 20, width: 200, height: 200 })
  assert.deepEqual(
    p1.map((x) => ({ id: x.id, x: x.x, y: x.y, r: x.r })),
    p2.map((x) => ({ id: x.id, x: x.x, y: x.y, r: x.r })),
  )
  const a = p1.find((x) => x.id === "a")!
  const b = p1.find((x) => x.id === "b")!
  assert.ok(a.r >= b.r)
})
