import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCoveragePreview,
  helperInputFromRow,
  summarizeEmbeddingSignalCoverage,
  type EmbeddingSignalCoverageRow,
} from "../lib/embeddings/signal-coverage.ts"
import { buildClassificationAwareEmbeddingText } from "../lib/embeddings/classification-aware-input.ts"

// All test rows use the production-shape: `llm_confidence` as a numeric
// string (e.g. "0.80") matching what PostgREST returns for numeric(3,2),
// and `review_flagged` as a boolean derived from classification_reviews.
// The previous tests used bucket strings ("high"/"low") which never
// matched real data — the broken implementation was self-consistent
// with broken tests.

test("summarizes coverage and distributions (numeric confidence shape)", () => {
  const summary = summarizeEmbeddingSignalCoverage([
    {
      observation_id: "1",
      category_slug: "performance",
      error_code: "E1",
      llm_category: "stability",
      llm_subcategory: "timeout",
      llm_primary_tag: "network",
      llm_confidence: "0.90",
      review_flagged: false,
    },
    {
      observation_id: "2",
      llm_category: "stability",
      llm_confidence: "0.40", // low
      review_flagged: false,
    },
    {
      observation_id: "3",
      llm_subcategory: "ui-lag",
      llm_confidence: "0.85", // high
      review_flagged: true,   // but reviewer rejected
    },
    {
      observation_id: "4",
      // No signals at all → raw-only fallback
    },
  ])

  assert.equal(summary.total_observations, 4)
  assert.equal(summary.with_topic, 1)
  assert.equal(summary.with_bug_fingerprint, 1)
  assert.equal(summary.with_any_llm_classification, 3)
  // High = bucketConfidence >= 0.80 (rows 1 and 3 qualify by score)
  assert.equal(summary.with_high_confidence_llm_classification, 2)
  assert.equal(summary.with_review_flagged_llm_classification, 1)
  // Usable = canUseTaxonomySignals AND has any LLM field
  // Row 1: high + not flagged + has fields → usable
  // Row 3: high + FLAGGED → NOT usable
  assert.equal(summary.with_usable_taxonomy_triplet, 1)
  // Raw-only = no topic, no fingerprint, AND not usable_taxonomy
  // Row 1: has topic + fingerprint → not raw-only
  // Row 2: no topic, no fingerprint, low confidence → raw-only
  // Row 3: no topic, no fingerprint, flagged → raw-only
  // Row 4: nothing → raw-only
  assert.equal(summary.raw_only_fallback_count, 3)
  assert.equal(summary.llm_category_distribution.stability, 2)
  assert.equal(summary.llm_subcategory_distribution.timeout, 1)
  assert.equal(summary.topic_distribution.performance, 1)

  // Confidence bucket distribution sanity-check: 2 high, 0 medium,
  // 1 low, 1 unknown (row 4 has null confidence).
  assert.equal(summary.confidence_bucket_distribution.high, 2)
  assert.equal(summary.confidence_bucket_distribution.medium, 0)
  assert.equal(summary.confidence_bucket_distribution.low, 1)
  assert.equal(summary.confidence_bucket_distribution.unknown, 1)
})

test("medium-confidence rows ARE counted as usable (matches helper gate)", () => {
  // Phase 1 spec: helper gates on "high OR medium". Metric MUST agree
  // — the previous implementation used a "high only" set lookup that
  // silently dropped medium-confidence rows from the usable count.
  const summary = summarizeEmbeddingSignalCoverage([
    {
      observation_id: "1",
      llm_category: "ux",
      llm_confidence: "0.65", // medium
      review_flagged: false,
    },
  ])
  assert.equal(summary.with_usable_taxonomy_triplet, 1)
  assert.equal(summary.with_high_confidence_llm_classification, 0) // diagnostic counter — high only
  assert.equal(summary.confidence_bucket_distribution.medium, 1)
})

test("distributions are top-K with _other tail bucket", () => {
  // Generate 25 unique categories; default K=20 should slice to 20 + _other.
  const rows: EmbeddingSignalCoverageRow[] = Array.from({ length: 25 }, (_, i) => ({
    observation_id: `${i}`,
    llm_category: `cat_${String(i).padStart(2, "0")}`,
    llm_confidence: "0.90",
    review_flagged: false,
  }))
  const summary = summarizeEmbeddingSignalCoverage(rows)
  const keys = Object.keys(summary.llm_category_distribution)
  // 20 head + 1 _other = 21 keys total
  assert.equal(keys.length, 21)
  assert.ok(keys.includes("_other"))
  assert.equal(summary.llm_category_distribution._other, 5) // tail of 5
})

test("buildCoveragePreview labels omission reasons correctly", () => {
  const rows = buildCoveragePreview([
    {
      observation_id: "1",
      title: "T1",
      llm_category: "bug",
      llm_confidence: "0.40", // low
      review_flagged: false,
    },
    {
      observation_id: "2",
      title: "T2",
      llm_category: "bug",
      llm_confidence: "0.95", // high
      review_flagged: true,   // but reviewer rejected
    },
    {
      observation_id: "3",
      title: "T3",
      llm_category: "bug",
      llm_confidence: "0.95",
      category_slug: "ux-ui",
      error_code: "E1",
      review_flagged: false,
    },
  ])
  assert.ok(rows[0].omitted_reasons.includes("llm_low_confidence"))
  assert.ok(rows[1].omitted_reasons.includes("llm_review_flagged"))
  assert.ok(rows[2].included_fields.includes("llm_taxonomy"))
})

test("buildCoveragePreview returns BOTH raw and classification-aware text for side-by-side comparison", () => {
  // Phase 2 spec calls for the preview to surface what an embedding
  // would contain WITH and WITHOUT v3's structured signals so an
  // operator can verify "v3 actually adds something here" before
  // proceeding to Phase 4.
  const [row] = buildCoveragePreview([
    {
      observation_id: "1",
      title: "Crash on save",
      content: "Repro when opening palette",
      category_slug: "ux-ui",
      error_code: "EBADSTATE",
      llm_category: "bug",
      llm_subcategory: "state-loss",
      llm_confidence: "0.92",
      review_flagged: false,
    },
  ])

  // Raw is title + summary only — no Topic, no Error, no Category.
  assert.match(row.raw_embedding_text, /^Title: Crash on save\nSummary: Repro when opening palette$/)
  assert.doesNotMatch(row.raw_embedding_text, /Topic:/)
  assert.doesNotMatch(row.raw_embedding_text, /Error:/)
  assert.doesNotMatch(row.raw_embedding_text, /Category:/)

  // Classification-aware includes everything raw has PLUS structured signals.
  assert.match(row.classification_embedding_text, /Title: Crash on save/)
  assert.match(row.classification_embedding_text, /Summary: Repro when opening palette/)
  assert.match(row.classification_embedding_text, /Topic: ux-ui/)
  assert.match(row.classification_embedding_text, /Error: EBADSTATE/)
  assert.match(row.classification_embedding_text, /Category: bug/)
  assert.match(row.classification_embedding_text, /Subcategory: state-loss/)

  // The point of having both: classification-aware MUST be longer than raw
  // (or equal, when no signals are available) — never shorter.
  assert.ok(row.classification_embedding_text.length >= row.raw_embedding_text.length)
})

test("buildCoveragePreview raw and classification text are EQUAL when no structured signals", () => {
  // For a row with no Topic / fingerprint / classification, v3 has
  // nothing to add and degrades to raw-equivalent. Both strings should
  // be identical, which lets an operator visually confirm "this row
  // doesn't benefit from v3".
  const [row] = buildCoveragePreview([
    {
      observation_id: "1",
      title: "Just a title",
      content: "Just a body",
    },
  ])
  assert.equal(row.raw_embedding_text, row.classification_embedding_text)
})

test("preview review_flagged short-circuits before low_confidence", () => {
  // A row with both low confidence AND review-flagged is more
  // actionably labeled "review_flagged" — the reviewer explicitly
  // rejected it, so raising confidence won't help.
  const [row] = buildCoveragePreview([
    {
      observation_id: "1",
      title: "T",
      llm_category: "bug",
      llm_confidence: "0.30",
      review_flagged: true,
    },
  ])
  assert.ok(row.omitted_reasons.includes("llm_review_flagged"))
  assert.ok(!row.omitted_reasons.includes("llm_low_confidence"))
})

test("medium confidence in preview → llm_taxonomy is INCLUDED (not omitted)", () => {
  const [row] = buildCoveragePreview([
    {
      observation_id: "1",
      title: "T",
      llm_category: "bug",
      llm_confidence: "0.60", // medium
      review_flagged: false,
    },
  ])
  assert.ok(row.included_fields.includes("llm_taxonomy"))
  assert.ok(!row.omitted_reasons.some((r) => r.startsWith("llm_")))
})

// ============================================================================
// Derived percentages — the Phase 2 decision-gate inputs
// ============================================================================

test("summary.percentages computes ratios at 4-decimal precision", () => {
  const summary = summarizeEmbeddingSignalCoverage([
    {
      observation_id: "1",
      llm_category: "bug",
      llm_confidence: "0.90",
      category_slug: "ux-ui",
      review_flagged: false,
    },
    {
      observation_id: "2",
      llm_category: "bug",
      llm_confidence: "0.40",
      review_flagged: false,
    },
    { observation_id: "3" }, // no signals → raw-only
    { observation_id: "4" }, // no signals → raw-only
  ])

  // 1 of 4 has usable taxonomy (high-conf with topic)
  assert.equal(summary.percentages.usable_taxonomy_pct, 0.25)
  // 2 of 4 are raw-only (rows 3 + 4 — row 2 has llm_category so not raw-only,
  //                        but it's not usable either; classification helper still
  //                        produces only Title + Summary for row 2, so... wait)
  // Actually row 2 has llm_category populated — `with_any_llm_classification`
  // counts it. But raw-only is defined as no topic AND no fingerprint AND no
  // usable taxonomy. Row 2 has none of those → raw-only.
  assert.equal(summary.percentages.raw_only_pct, 0.75)
  assert.equal(summary.percentages.high_confidence_pct, 0.25)
  assert.equal(summary.percentages.low_confidence_pct, 0.25)
  assert.equal(summary.percentages.review_flagged_pct, 0)
  // Any-structured-signal = rows that aren't raw-only = 1 of 4
  assert.equal(summary.percentages.any_structured_signal_pct, 0.25)
})

test("summary.percentages returns null on empty input (no divide-by-zero)", () => {
  const summary = summarizeEmbeddingSignalCoverage([])
  assert.equal(summary.percentages.usable_taxonomy_pct, null)
  assert.equal(summary.percentages.raw_only_pct, null)
  assert.equal(summary.percentages.high_confidence_pct, null)
  assert.equal(summary.percentages.review_flagged_pct, null)
  assert.equal(summary.percentages.any_structured_signal_pct, null)
})

// ============================================================================
// helperInputFromRow → buildClassificationAwareEmbeddingText parity
//
// Phase 4 PR2's production wiring will reuse helperInputFromRow to map
// flat DB rows into the helper's input shape. If the row type or the
// helper's input shape ever grows a field without the mapper updating,
// signals silently disappear from the v3 embedding text. The test below
// builds a fully-populated EmbeddingSignalCoverageRow and asserts every
// expected line lands in the v3 output. Adding a new field to either
// shape WITHOUT updating this test means the mapper isn't covered for
// that field — the test will fail to prove the lift-through happens.
// ============================================================================

test("helperInputFromRow → buildClassificationAwareEmbeddingText: every coverage-row field reaches v3 text", () => {
  const fullRow: EmbeddingSignalCoverageRow = {
    observation_id: "obs-full",
    title: "Full row test",
    content: "Body content for full row test",
    category_slug: "performance",
    error_code: "TIMEOUT",
    top_stack_frame: "save_handler",
    cli_version: "0.10.4",
    fp_os: "macos",
    fp_shell: "zsh",
    fp_editor: "vscode",
    model_id: "gpt-4o",
    repro_markers: 3,
    llm_category: "bugs",
    llm_subcategory: "ui-freeze",
    llm_primary_tag: "blocking",
    llm_severity: "high",
    llm_reproducibility: "always",
    llm_impact: "single-user",
    llm_confidence: "0.90",
    llm_tags: ["alpha", "beta"],
    review_flagged: false,
    reviewer_category: null,
    reviewer_subcategory: null,
  }

  const helperInput = helperInputFromRow(fullRow)
  const text = buildClassificationAwareEmbeddingText(helperInput)

  // Tier 1 — primary
  assert.match(text, /^Title: Full row test$/m)
  assert.match(text, /^Summary: Body content for full row test$/m)
  assert.match(text, /^Topic: performance$/m)
  assert.match(text, /^Category: bugs$/m)
  assert.match(text, /^Subcategory: ui-freeze$/m)
  assert.match(text, /^Tags: alpha, beta$/m)

  // Tier 2 — secondary
  assert.match(text, /^Severity: high$/m)
  assert.match(text, /^Reproducibility: always$/m)
  assert.match(text, /^Impact: single-user$/m)
  assert.match(text, /^Confidence: high$/m)

  // Tier 3 — supportive (collapsed)
  assert.match(text, /^Environment: cli=0\.10\.4 os=macos shell=zsh editor=vscode model=gpt-4o$/m)
  assert.match(text, /^Error: TIMEOUT$/m)
  assert.match(text, /^Stack: save_handler$/m)
  assert.match(text, /^Repro markers: 3$/m)

  // No legacy individual fingerprint lines (collapse must hold).
  assert.doesNotMatch(text, /^CLI:/m)
  assert.doesNotMatch(text, /^OS:/m)
  assert.doesNotMatch(text, /^Shell:/m)
  assert.doesNotMatch(text, /^Editor:/m)
  assert.doesNotMatch(text, /^Model:/m)
})

test("helperInputFromRow: review-flagged row omits Tier 1 LLM AND Tier 2 scalars", () => {
  // Stronger gate than low confidence: a reviewer explicitly rejected
  // this LLM output. Helper should omit category/subcategory/tags
  // (Tier 1 LLM signals) AND severity/reproducibility/impact/confidence
  // (Tier 2 scalars) — every field that came from the rejected LLM
  // call.
  const flaggedRow: EmbeddingSignalCoverageRow = {
    observation_id: "obs-flagged",
    title: "T",
    content: "B",
    category_slug: "performance",
    llm_category: "bugs",
    llm_subcategory: "ui",
    llm_severity: "high",
    llm_reproducibility: "always",
    llm_impact: "single-user",
    llm_confidence: "0.90",
    llm_tags: ["alpha"],
    review_flagged: true,
  }

  const helperInput = helperInputFromRow(flaggedRow)
  const text = buildClassificationAwareEmbeddingText(helperInput)

  // Title / Summary / Topic still present (not LLM-derived).
  assert.match(text, /^Title: T$/m)
  assert.match(text, /^Topic: performance$/m)

  // All LLM signals (Tier 1 + Tier 2) gated out.
  assert.doesNotMatch(text, /^Category:/m)
  assert.doesNotMatch(text, /^Subcategory:/m)
  assert.doesNotMatch(text, /^Tags:/m)
  assert.doesNotMatch(text, /^Severity:/m)
  assert.doesNotMatch(text, /^Reproducibility:/m)
  assert.doesNotMatch(text, /^Impact:/m)
  assert.doesNotMatch(text, /^Confidence:/m)
})

test("helperInputFromRow: low-confidence (not flagged) emits Tier 2 scalars but not Tier 1 LLM", () => {
  // Existing rationale: at low confidence, the LLM's per-axis scalar
  // self-rating is still honest data. Only the taxonomy strings are
  // gated (to prevent hallucinated category/tag false-positive
  // grouping). Pinning this distinction so the gate-on-flagged change
  // doesn't accidentally tighten the low-confidence case too.
  const lowConfRow: EmbeddingSignalCoverageRow = {
    observation_id: "obs-low",
    title: "T",
    llm_category: "bugs",
    llm_subcategory: "ui",
    llm_severity: "high",
    llm_reproducibility: "always",
    llm_impact: "single-user",
    llm_confidence: "0.30",
    llm_tags: ["alpha"],
    review_flagged: false,
  }

  const helperInput = helperInputFromRow(lowConfRow)
  const text = buildClassificationAwareEmbeddingText(helperInput)

  // Tier 1 LLM signals gated out (low confidence).
  assert.doesNotMatch(text, /^Category:/m)
  assert.doesNotMatch(text, /^Subcategory:/m)
  assert.doesNotMatch(text, /^Tags:/m)

  // Tier 2 scalars STILL emitted (only review_flagged gates these).
  assert.match(text, /^Severity: high$/m)
  assert.match(text, /^Reproducibility: always$/m)
  assert.match(text, /^Impact: single-user$/m)
  assert.match(text, /^Confidence: low$/m)
})

test("summary.confidence_bucket_distribution sums to total_observations", () => {
  // Invariant: every row falls into exactly one bucket. The four
  // bucket counts must sum to total — guards against double-counting
  // or skipping rows in the loop.
  const summary = summarizeEmbeddingSignalCoverage([
    { observation_id: "1", llm_confidence: "0.90" }, // high
    { observation_id: "2", llm_confidence: "0.65" }, // medium
    { observation_id: "3", llm_confidence: "0.30" }, // low
    { observation_id: "4" },                          // unknown (null confidence)
    { observation_id: "5", llm_confidence: "not-a-number" }, // unknown
  ])
  const dist = summary.confidence_bucket_distribution
  assert.equal(dist.high + dist.medium + dist.low + dist.unknown, summary.total_observations)
  assert.equal(dist.high, 1)
  assert.equal(dist.medium, 1)
  assert.equal(dist.low, 1)
  assert.equal(dist.unknown, 2)
})
