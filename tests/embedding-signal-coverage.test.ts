import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCoveragePreview,
  summarizeEmbeddingSignalCoverage,
  type EmbeddingSignalCoverageRow,
} from "../lib/embeddings/signal-coverage.ts"

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
