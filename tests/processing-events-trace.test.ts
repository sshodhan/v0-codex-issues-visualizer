import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { buildObservationTrace, sortProcessingEvents, type ProcessingEventRow } from "../lib/processing-events/trace.ts"

function row(partial: Partial<ProcessingEventRow>): ProcessingEventRow {
  return {
    id: partial.id ?? crypto.randomUUID(),
    stage: partial.stage ?? "classification",
    status: partial.status ?? "attempted",
    algorithm_version_model: partial.algorithm_version_model ?? null,
    detail_json: partial.detail_json ?? {},
    created_at: partial.created_at ?? "2026-01-01T00:00:00.000Z",
  }
}

test("sortProcessingEvents orders by created_at then id for stable timeline rendering", () => {
  const input = [
    row({ id: "c", created_at: "2026-01-01T00:00:01.000Z" }),
    row({ id: "b", created_at: "2026-01-01T00:00:00.000Z" }),
    row({ id: "a", created_at: "2026-01-01T00:00:00.000Z" }),
  ]

  const sorted = sortProcessingEvents(input)
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["a", "b", "c"],
  )
})

test("buildObservationTrace preserves classification retry/escalation chain", () => {
  const trace = buildObservationTrace([
    row({ stage: "fingerprinting", status: "completed", created_at: "2026-01-01T00:00:00.000Z" }),
    row({
      stage: "classification",
      status: "attempted",
      algorithm_version_model: "gpt-5-mini",
      created_at: "2026-01-01T00:00:01.000Z",
    }),
    row({
      stage: "classification",
      status: "escalated",
      algorithm_version_model: "gpt-5-mini->gpt-5",
      created_at: "2026-01-01T00:00:02.000Z",
    }),
    row({
      stage: "classification",
      status: "attempted",
      algorithm_version_model: "gpt-5",
      created_at: "2026-01-01T00:00:03.000Z",
    }),
    row({
      stage: "classification",
      status: "completed",
      algorithm_version_model: "gpt-5",
      created_at: "2026-01-01T00:00:04.000Z",
    }),
    row({ stage: "review", status: "completed", created_at: "2026-01-01T00:00:05.000Z" }),
  ])

  assert.equal(trace.classificationRetryChain.escalated, true)
  assert.deepEqual(trace.classificationRetryChain.attemptedModels, ["gpt-5-mini", "gpt-5"])
  assert.deepEqual(
    trace.events.map((event) => event.stage),
    ["fingerprinting", "classification", "classification", "classification", "classification", "review"],
  )
})
