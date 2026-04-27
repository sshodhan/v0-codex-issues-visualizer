import assert from "node:assert/strict"
import { test } from "node:test"
import { pickCalloutDirection, type BubbleGeom } from "./atlas-callout-direction.ts"

const CANVAS = { width: 600, height: 280 }

test("picks 'right' when the bubble has open space to the right", () => {
  const bubble: BubbleGeom = { x: 200, y: 140, r: 30 }
  const others: BubbleGeom[] = [{ x: 80, y: 140, r: 25 }] // neighbour to the left
  const out = pickCalloutDirection(bubble, others, {
    leaderLength: 50,
    canvas: CANVAS,
  })
  assert.ok(out.ux > 0, `expected ux > 0 (right-ish), got ${out.ux}`)
})

test("picks 'left' when the bubble has a neighbour blocking the right", () => {
  const bubble: BubbleGeom = { x: 300, y: 140, r: 40 }
  // Big neighbour immediately to the right (where the default would have pointed).
  const others: BubbleGeom[] = [{ x: 380, y: 140, r: 30 }]
  const out = pickCalloutDirection(bubble, others, {
    leaderLength: 50,
    canvas: CANVAS,
  })
  assert.ok(out.ux < 0, `expected leftward direction, got ${out.ux}`)
})

test("Bug-at-center scenario: prefers up/down/diagonal over the blocked right", () => {
  // Reproduces the production bug: largest bubble at canvas centre, neighbour
  // immediately to the right. The default heuristic pointed right and the label
  // landed on the neighbour. Picker should choose any direction other than
  // straight right.
  const bug: BubbleGeom = { x: 300, y: 140, r: 46 }
  const integration: BubbleGeom = { x: 380, y: 145, r: 28 }
  const out = pickCalloutDirection(bug, [integration], {
    leaderLength: 60,
    canvas: CANVAS,
    labelHalfWidth: 50,
  })
  // Verify the leader endpoint is clear of the integration bubble.
  const lx = bug.x + out.ux * 60
  const ly = bug.y + out.uy * 60
  const dist = Math.hypot(lx - integration.x, ly - integration.y) - integration.r
  assert.ok(dist > 8, `endpoint should clear integration (got ${dist.toFixed(1)}px)`)
})

test("respects edge padding — picker doesn't choose a direction that runs off-canvas", () => {
  // Bubble near the right edge → picker should not point right
  const bubble: BubbleGeom = { x: 580, y: 140, r: 14 }
  const out = pickCalloutDirection(bubble, [], {
    leaderLength: 30,
    canvas: CANVAS,
    edgePad: 6,
  })
  assert.ok(out.ux <= 0, `expected non-rightward direction near right edge, got ux=${out.ux}`)
})

test("falls back gracefully when all directions are blocked — still returns a vector", () => {
  // Surround a small bubble with neighbours on every side.
  const bubble: BubbleGeom = { x: 300, y: 140, r: 14 }
  const others: BubbleGeom[] = [
    { x: 360, y: 140, r: 30 },
    { x: 240, y: 140, r: 30 },
    { x: 300, y: 80, r: 30 },
    { x: 300, y: 200, r: 30 },
  ]
  const out = pickCalloutDirection(bubble, others, {
    leaderLength: 30,
    canvas: CANVAS,
  })
  // Whatever it picks, the unit vector should be non-zero and finite.
  assert.ok(Number.isFinite(out.ux))
  assert.ok(Number.isFinite(out.uy))
  assert.ok(Math.hypot(out.ux, out.uy) > 0.99)
  assert.ok(Math.hypot(out.ux, out.uy) < 1.01)
})

test("preferred direction wins on ties", () => {
  const bubble: BubbleGeom = { x: 300, y: 140, r: 30 }
  const out = pickCalloutDirection(bubble, [], {
    leaderLength: 50,
    canvas: CANVAS,
    preferred: { ux: -1, uy: 0 },
    tieEps: 5,
  })
  // No neighbours, no edge concerns → all directions tied → preferred wins
  assert.equal(out.ux, -1)
  assert.equal(out.uy, 0)
})

test("preferred direction loses when a clearly better direction exists", () => {
  const bubble: BubbleGeom = { x: 300, y: 140, r: 30 }
  // A massive neighbour blocks the preferred (left) direction.
  const others: BubbleGeom[] = [{ x: 220, y: 140, r: 60 }]
  const out = pickCalloutDirection(bubble, others, {
    leaderLength: 50,
    canvas: CANVAS,
    preferred: { ux: -1, uy: 0 },
    tieEps: 1,
  })
  assert.notEqual(out.ux, -1)
})

test("deterministic — same input returns the same direction", () => {
  const bubble: BubbleGeom = { x: 250, y: 130, r: 35 }
  const others: BubbleGeom[] = [
    { x: 320, y: 140, r: 25 },
    { x: 180, y: 100, r: 20 },
  ]
  const a = pickCalloutDirection(bubble, others, { leaderLength: 50, canvas: CANVAS })
  const b = pickCalloutDirection(bubble, others, { leaderLength: 50, canvas: CANVAS })
  assert.deepEqual(a, b)
})
