import test from "node:test"
import assert from "node:assert/strict"

import {
  bucketConfidence,
  buildClassificationAwareEmbeddingText,
  buildRawEmbeddingText,
  canUseTaxonomySignals,
} from "../lib/embeddings/classification-aware-input.ts"

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

test("medium-confidence classification category/subcategory/tags are INCLUDED", () => {
  // Phase 1 spec gates on "high or medium" — medium must be included
  // by the helper. The signal-coverage metric uses the same gate via
  // canUseTaxonomySignals so the two never drift.
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    classification: {
      category: "bugs",
      subcategory: "state-loss",
      tags: ["sync"],
      confidence_bucket: "medium",
    },
  })
  assert.match(text, /Category: bugs/)
  assert.match(text, /Subcategory: state-loss/)
  assert.match(text, /Tags: sync/)
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

test("repro markers count: emitted only when count >= 2", () => {
  // Schema reality: bug_fingerprints.repro_markers is `integer` (count),
  // not `text[]` (list). Helper now matches.
  const lowCount = buildClassificationAwareEmbeddingText({
    title: "A",
    bugFingerprint: { repro_markers: 1 },
  })
  assert.doesNotMatch(lowCount, /Repro markers/)

  const zeroCount = buildClassificationAwareEmbeddingText({
    title: "A",
    bugFingerprint: { repro_markers: 0 },
  })
  assert.doesNotMatch(zeroCount, /Repro markers/)

  const highCount = buildClassificationAwareEmbeddingText({
    title: "A",
    bugFingerprint: { repro_markers: 5 },
  })
  assert.match(highCount, /Repro markers: 5/)
})

test("summary is truncated to bounded length", () => {
  const longBody = "x".repeat(1500)
  const text = buildClassificationAwareEmbeddingText({ title: "A", body: longBody })
  const summaryLine = text.split("\n").find((line) => line.startsWith("Summary: "))
  assert.ok(summaryLine)
  assert.equal(summaryLine!.length, "Summary: ".length + 1200)
})

test("tag sorting is stable ascii order", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    classification: {
      category: "bugs",
      confidence_bucket: "high",
      tags: ["b", "A", "a"],
    },
  })
  assert.match(text, /Tags: A, a, b/)
})

// ============================================================================
// bucketConfidence — numeric and string-numeric inputs
// ============================================================================

test("bucketConfidence: high boundary at 0.80 inclusive", () => {
  assert.equal(bucketConfidence(0.8), "high")
  assert.equal(bucketConfidence(0.95), "high")
  assert.equal(bucketConfidence(1.0), "high")
})

test("bucketConfidence: medium range [0.50, 0.80)", () => {
  assert.equal(bucketConfidence(0.5), "medium")
  assert.equal(bucketConfidence(0.65), "medium")
  // Just below 0.80
  assert.equal(bucketConfidence(0.7999), "medium")
})

test("bucketConfidence: low below 0.50", () => {
  assert.equal(bucketConfidence(0.0), "low")
  assert.equal(bucketConfidence(0.49), "low")
})

test("bucketConfidence: numeric strings are coerced (PostgREST returns numeric as string)", () => {
  // Critical: the production schema returns `classifications.confidence`
  // (numeric(3,2)) as a JSON string like "0.80" — the previous
  // implementation's HIGH_CONFIDENCE_VALUES set lookup never matched
  // these and silently reported 0% high-confidence forever.
  assert.equal(bucketConfidence("0.80"), "high")
  assert.equal(bucketConfidence("0.65"), "medium")
  assert.equal(bucketConfidence("0.20"), "low")
})

test("bucketConfidence: null/undefined/non-finite map to 'unknown'", () => {
  assert.equal(bucketConfidence(null), "unknown")
  assert.equal(bucketConfidence(undefined), "unknown")
  assert.equal(bucketConfidence("not-a-number"), "unknown")
  assert.equal(bucketConfidence(Number.NaN), "unknown")
})

// ============================================================================
// canUseTaxonomySignals — exported gate
// ============================================================================

// ============================================================================
// buildRawEmbeddingText — baseline for Phase 2 preview comparison
// ============================================================================

test("buildRawEmbeddingText: title-only when body absent", () => {
  assert.equal(buildRawEmbeddingText("My title"), "Title: My title")
  assert.equal(buildRawEmbeddingText("My title", null), "Title: My title")
  assert.equal(buildRawEmbeddingText("My title", ""), "Title: My title")
  assert.equal(buildRawEmbeddingText("My title", "   "), "Title: My title")
})

test("buildRawEmbeddingText: trims title and body", () => {
  assert.equal(
    buildRawEmbeddingText("  My title  ", "  My body  "),
    "Title: My title\nSummary: My body",
  )
})

test("buildRawEmbeddingText: applies the same body truncation as the classification-aware variant", () => {
  // Both functions use SUMMARY_MAX (1200). Critical: the raw vs
  // classification-aware preview comparison MUST start from the same
  // base — if raw truncates differently, the operator can't tell
  // whether observed length differences come from v3's signals or
  // from inconsistent truncation.
  const longBody = "x".repeat(1500)
  const raw = buildRawEmbeddingText("A", longBody)
  const cls = buildClassificationAwareEmbeddingText({ title: "A", body: longBody })
  // The "Summary: " prefix length is 9; total line length should be
  // 9 + 1200 = 1209 in both.
  const rawSummary = raw.split("\n").find((l) => l.startsWith("Summary: "))
  const clsSummary = cls.split("\n").find((l) => l.startsWith("Summary: "))
  assert.equal(rawSummary?.length, 1209)
  assert.equal(clsSummary?.length, 1209)
})

test("canUseTaxonomySignals: gates exactly as documented", () => {
  // High + not flagged → use
  assert.equal(canUseTaxonomySignals({ confidence_bucket: "high" }), true)
  // Medium + not flagged → use (same as helper internal behavior)
  assert.equal(canUseTaxonomySignals({ confidence_bucket: "medium" }), true)
  // Low → reject
  assert.equal(canUseTaxonomySignals({ confidence_bucket: "low" }), false)
  // Unknown → reject
  assert.equal(canUseTaxonomySignals({ confidence_bucket: "unknown" }), false)
  // High but flagged → reject
  assert.equal(
    canUseTaxonomySignals({ confidence_bucket: "high", review_flagged: true }),
    false,
  )
  // null/undefined classification → reject
  assert.equal(canUseTaxonomySignals(null), false)
  assert.equal(canUseTaxonomySignals(undefined), false)
})
