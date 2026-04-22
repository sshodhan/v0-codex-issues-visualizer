import test from "node:test"
import assert from "node:assert/strict"

import {
  buildEmbeddingInputText,
  clusterEmbeddings,
  cosineSimilarity,
} from "../lib/storage/semantic-cluster-core.ts"

test("clusters same-meaning observations even with different wording", () => {
  const observations = [
    {
      id: "obs-1",
      title: "CLI hangs when opening big repo",
      embedding: [1, 0, 0],
    },
    {
      id: "obs-2",
      title: "Large monorepo causes codex freeze",
      embedding: [0.97, 0.03, 0],
    },
    {
      id: "obs-3",
      title: "Theme toggle icon is misaligned",
      embedding: [0, 1, 0],
    },
  ]

  const result = clusterEmbeddings(observations, 0.9, 2)

  assert.equal(result.semanticGroups.length, 1)
  assert.deepEqual(
    result.semanticGroups[0].map((r) => r.id).sort(),
    ["obs-1", "obs-2"],
  )
  assert.deepEqual(result.fallbackObservationIds, ["obs-3"])
})

test("minClusterSize enforces deterministic fallback for small groups", () => {
  const observations = [
    { id: "obs-1", title: "A", embedding: [1, 0] },
    { id: "obs-2", title: "B", embedding: [1, 0] },
  ]

  const grouped = clusterEmbeddings(observations, 0.95, 3)
  assert.equal(grouped.semanticGroups.length, 0)
  assert.deepEqual(grouped.fallbackObservationIds.sort(), ["obs-1", "obs-2"])
})

test("embedding input includes optional summary", () => {
  const withSummary = buildEmbeddingInputText("Codex crashes", "Stack trace and repro steps")
  assert.match(withSummary, /^Title: Codex crashes\nSummary: /)

  const withoutSummary = buildEmbeddingInputText("Codex crashes", null)
  assert.equal(withoutSummary, "Title: Codex crashes")
})

test("cosineSimilarity handles invalid vectors", () => {
  assert.equal(cosineSimilarity([], []), -1)
  assert.equal(cosineSimilarity([1, 0], [1]), -1)
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
})
