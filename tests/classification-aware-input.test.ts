import test from "node:test"
import assert from "node:assert/strict"

import {
  V3_ALGORITHM_SIGNATURE,
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

// ============================================================================
// Tier ordering and Environment collapse — locked by the plan doc's
// "Corpus characteristics" section. Reordering signals here without
// also updating these tests AND bumping the algorithm version is a
// reproducibility violation: existing v3 rows would no longer be
// derivable from the new code.
// ============================================================================

test("tier ordering: Tier 1 (primary) → Tier 2 (secondary) → Tier 3 (supportive)", () => {
  // Build an input where every emit-worthy field is populated, so we
  // can pin the full ordered output. Reordering inputs in this object
  // literal MUST NOT change output order — order is structural, not
  // input-dependent.
  const text = buildClassificationAwareEmbeddingText({
    title: "App freezes on save",
    body: "Body text describing the freeze",
    topic: "performance",
    classification: {
      category: "bugs",
      subcategory: "ui-freeze",
      tags: ["zeta", "alpha"],
      severity: "high",
      reproducibility: "always",
      impact: "blocking",
      confidence_bucket: "high",
    },
    bugFingerprint: {
      cli_version: "0.10.4",
      os: "macos",
      shell: "zsh",
      editor: "vscode",
      model_id: "gpt-4o",
      error_code: "TIMEOUT",
      top_stack_frame: "save_handler",
      repro_markers: 3,
    },
  })

  const expectedOrder = [
    /^Title: /, // Tier 1
    /^Summary: /, // Tier 1
    /^Topic: /, // Tier 1
    /^Category: /, // Tier 1
    /^Subcategory: /, // Tier 1
    /^Tags: /, // Tier 1
    /^Severity: /, // Tier 2
    /^Reproducibility: /, // Tier 2
    /^Impact: /, // Tier 2
    /^Confidence: /, // Tier 2
    /^Environment: /, // Tier 3 (collapsed)
    /^Error: /, // Tier 3
    /^Stack: /, // Tier 3
    /^Repro markers: /, // Tier 3
  ]

  const lines = text.split("\n")
  assert.equal(
    lines.length,
    expectedOrder.length,
    `expected ${expectedOrder.length} lines, got ${lines.length}\n${text}`,
  )
  for (let i = 0; i < expectedOrder.length; i++) {
    assert.match(
      lines[i],
      expectedOrder[i],
      `line ${i} should match ${expectedOrder[i]} but got: ${lines[i]}`,
    )
  }
})

test("Environment collapse: 5 fingerprint fields → ONE Environment line, not five", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    bugFingerprint: {
      cli_version: "0.10.4",
      os: "macos",
      shell: "zsh",
      editor: "vscode",
      model_id: "gpt-4o",
    },
  })

  // Exactly one Environment line.
  const envLines = text.split("\n").filter((l) => l.startsWith("Environment:"))
  assert.equal(envLines.length, 1, `expected 1 Environment line, got ${envLines.length}\n${text}`)

  // The collapsed form contains all five k=v pairs in fixed order.
  assert.match(envLines[0], /^Environment: cli=0\.10\.4 os=macos shell=zsh editor=vscode model=gpt-4o$/)

  // No legacy individual lines.
  assert.doesNotMatch(text, /^CLI:/m)
  assert.doesNotMatch(text, /^OS:/m)
  assert.doesNotMatch(text, /^Shell:/m)
  assert.doesNotMatch(text, /^Editor:/m)
  assert.doesNotMatch(text, /^Model:/m)
})

test("Environment line: omitted entirely when no fingerprint env fields populated", () => {
  // error_code and top_stack_frame are NOT part of Environment; they
  // get their own lines. So a row with only error_code should not
  // produce an empty Environment: line.
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    bugFingerprint: {
      error_code: "EACCES",
    },
  })
  assert.doesNotMatch(text, /^Environment:/m)
  assert.match(text, /^Error: EACCES$/m)
})

test("Environment line: filters 'unknown' values (sentinel pollution guard)", () => {
  const text = buildClassificationAwareEmbeddingText({
    title: "A",
    bugFingerprint: {
      cli_version: "0.10.4",
      os: "unknown",
      editor: "UNKNOWN",
      model_id: "gpt-4o",
    },
  })
  const envLine = text.split("\n").find((l) => l.startsWith("Environment:"))
  assert.ok(envLine)
  assert.match(envLine!, /cli=0\.10\.4/)
  assert.match(envLine!, /model=gpt-4o/)
  assert.doesNotMatch(envLine!, /os=/)
  assert.doesNotMatch(envLine!, /editor=/)
})

test("Tier 2 scalars: review_flagged omits Severity/Reproducibility/Impact/Confidence", () => {
  // Stronger gate than low confidence: a reviewer explicitly rejected
  // this LLM output. The helper omits ALL LLM-sourced lines (both
  // Tier 1 taxonomy and Tier 2 scalars) — every field that came from
  // the rejected LLM call.
  const text = buildClassificationAwareEmbeddingText({
    title: "T",
    classification: {
      category: "bugs",
      subcategory: "ui",
      tags: ["alpha"],
      severity: "high",
      reproducibility: "always",
      impact: "blocking",
      confidence_bucket: "high",
      review_flagged: true,
    },
  })
  // Title still present (not LLM-derived).
  assert.match(text, /^Title: T$/m)
  // All LLM signals omitted.
  assert.doesNotMatch(text, /^Category:/m)
  assert.doesNotMatch(text, /^Subcategory:/m)
  assert.doesNotMatch(text, /^Tags:/m)
  assert.doesNotMatch(text, /^Severity:/m)
  assert.doesNotMatch(text, /^Reproducibility:/m)
  assert.doesNotMatch(text, /^Impact:/m)
  assert.doesNotMatch(text, /^Confidence:/m)
})

test("Tier 2 scalars: low-confidence (NOT flagged) STILL emits scalars (only Tier 1 gated)", () => {
  // The Phase 1 rationale stands for low-confidence-but-not-flagged
  // rows: the LLM's per-axis scalar self-rating is honest data even
  // when overall confidence is low. Only the taxonomy strings (which
  // can hallucinate category/tag values) are gated on confidence.
  // Pinning this so the review_flagged gate doesn't accidentally
  // also tighten the low-confidence case.
  const text = buildClassificationAwareEmbeddingText({
    title: "T",
    classification: {
      category: "bugs",
      subcategory: "ui",
      tags: ["alpha"],
      severity: "high",
      reproducibility: "always",
      impact: "blocking",
      confidence_bucket: "low",
      // review_flagged not set — defaults to undefined/false
    },
  })
  // Tier 1 LLM signals gated out (low confidence).
  assert.doesNotMatch(text, /^Category:/m)
  assert.doesNotMatch(text, /^Subcategory:/m)
  assert.doesNotMatch(text, /^Tags:/m)
  // Tier 2 scalars STILL emitted (the only thing that gates these is review_flagged).
  assert.match(text, /^Severity: high$/m)
  assert.match(text, /^Reproducibility: always$/m)
  assert.match(text, /^Impact: blocking$/m)
  assert.match(text, /^Confidence: low$/m)
})

test("V3_ALGORITHM_SIGNATURE: locked numeric parameters", () => {
  // Pinning the version-defining numeric parameters in the test so a
  // future change forces an explicit choice: re-tune in this test AND
  // bump the algorithm version, OR don't change the numbers.
  // Re-tuning silently is a reproducibility violation.
  assert.equal(V3_ALGORITHM_SIGNATURE.summary_max, 1200)
  assert.equal(V3_ALGORITHM_SIGNATURE.field_value_max, 200)
  assert.equal(V3_ALGORITHM_SIGNATURE.confidence_high_min, 0.8)
  assert.equal(V3_ALGORITHM_SIGNATURE.confidence_medium_min, 0.5)
  assert.equal(V3_ALGORITHM_SIGNATURE.repro_marker_min, 2)
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
