import test from "node:test"
import assert from "node:assert/strict"

import { buildCoveragePreview, summarizeEmbeddingSignalCoverage } from "../lib/embeddings/signal-coverage.ts"

test("summarizes coverage and distributions", () => {
  const summary = summarizeEmbeddingSignalCoverage([
    {
      observation_id: "1",
      category_slug: "performance",
      error_code: "E1",
      llm_category: "stability",
      llm_subcategory: "timeout",
      llm_primary_tag: "network",
      llm_confidence: "high",
      llm_review_status: "approved",
    },
    {
      observation_id: "2",
      llm_category: "stability",
      llm_confidence: "low",
      llm_review_status: "approved",
    },
    {
      observation_id: "3",
      llm_subcategory: "ui-lag",
      llm_confidence: "high",
      llm_review_status: "flagged",
    },
    {
      observation_id: "4",
    },
  ])

  assert.equal(summary.total_observations, 4)
  assert.equal(summary.with_topic, 1)
  assert.equal(summary.with_bug_fingerprint, 1)
  assert.equal(summary.with_any_llm_classification, 3)
  assert.equal(summary.with_high_confidence_llm_classification, 2)
  assert.equal(summary.with_review_flagged_llm_classification, 1)
  assert.equal(summary.with_usable_taxonomy_triplet, 1)
  assert.equal(summary.raw_only_fallback_count, 3)
  assert.equal(summary.llm_category_distribution.stability, 2)
  assert.equal(summary.llm_subcategory_distribution.timeout, 1)
  assert.equal(summary.topic_distribution.performance, 1)
})

test("buildCoveragePreview marks omitted reasons", () => {
  const rows = buildCoveragePreview([
    { observation_id: "1", title: "T1", llm_category: "bug", llm_confidence: "low" },
    { observation_id: "2", title: "T2", llm_category: "bug", llm_confidence: "high", llm_review_status: "flagged" },
    { observation_id: "3", title: "T3", llm_category: "bug", llm_confidence: "high", category_slug: "ux-ui", error_code: "E1" },
  ])
  assert.deepEqual(rows[0].omitted_reasons.includes("llm_low_confidence"), true)
  assert.deepEqual(rows[1].omitted_reasons.includes("llm_review_flagged"), true)
  assert.deepEqual(rows[2].included_fields.includes("llm_taxonomy"), true)
})
