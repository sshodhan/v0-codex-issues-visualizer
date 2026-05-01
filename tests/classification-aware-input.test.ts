import test from "node:test"
import assert from "node:assert/strict"

import { buildClassificationAwareEmbeddingText } from "../lib/embeddings/classification-aware-input.ts"

test("raw title/body always present", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "  Crash on save  ",
    body: "  Repro when opening palette  ",
  })
  assert.match(text, /^Title: Crash on save/m)
  assert.match(text, /Summary: Repro when opening palette/m)
})

test("missing optional fields omitted", () => {
  const text = buildClassificationAwareEmbeddingText({ title: "A", classification: { confidence_bucket: "unknown" } })
  assert.equal(text, "Title: A")
})

test("tags are sorted deterministically", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    classification: {
      category: "bugs",
      confidence_bucket: "high",
      tags: ["zeta", "alpha", "alpha", " beta "],
    },
  })
  assert.match(text, /Tags: alpha, beta, zeta/)
})

test("low-confidence classification category/subcategory/tags are omitted", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    classification: {
      category: "bugs",
      subcategory: "state-loss",
      tags: ["sync"],
      confidence_bucket: "low",
    },
  })
  assert.doesNotMatch(text, /Category:/)
  assert.doesNotMatch(text, /Subcategory:/)
  assert.doesNotMatch(text, /Tags:/)
})

test("review-flagged classification category/subcategory/tags are omitted", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    classification: {
      category: "bugs",
      subcategory: "state-loss",
      tags: ["sync"],
      confidence_bucket: "high",
      review_flagged: true,
    },
  })
  assert.doesNotMatch(text, /Category:/)
  assert.doesNotMatch(text, /Subcategory:/)
  assert.doesNotMatch(text, /Tags:/)
})

test("reviewer override preferred", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    classification: {
      category: "bugs",
      subcategory: "other",
      reviewer_category: "usability",
      reviewer_subcategory: "keyboard-shortcuts",
      confidence_bucket: "high",
    },
  })
  assert.match(text, /Category: usability/)
  assert.match(text, /Subcategory: keyboard-shortcuts/)
})

test("evidence quotes are excluded", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    classification: {
      confidence_bucket: "high",
      category: "bugs",
      evidence_quotes: ["very long quote"],
    },
  })
  assert.doesNotMatch(text, /quote/i)
})

test("repro markers are de-duplicated and sorted", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    bugFingerprint: {
      repro_markers: ["intermittent", "always", "always", " sometimes "],
    },
  })
  assert.match(text, /Repro markers: always, intermittent, sometimes/)
})
