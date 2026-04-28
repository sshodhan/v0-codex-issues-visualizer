import test from "node:test"
import assert from "node:assert/strict"

import { __testing } from "../lib/storage/cluster-topic-metadata.ts"

// Pure-function tests for the row-shape coercion in
// lib/storage/cluster-topic-metadata.ts. Locks the boundary contract
// between the Postgres `mv_cluster_topic_metadata` row shape (NUMERIC
// → string, JSONB → unknown) and the typed JS surface used by
// admin/debug consumers. See docs/CLUSTERING_DESIGN.md §4.6.

const { rowToMetadata, toDistribution, toPhrases, toNumber, toNullableNumber } = __testing

test("toNumber coerces NUMERIC strings and falls back to 0", () => {
  assert.equal(toNumber("0.7500"), 0.75)
  assert.equal(toNumber(0.5), 0.5)
  assert.equal(toNumber(null), 0)
  assert.equal(toNumber(undefined), 0)
  assert.equal(toNumber("not-a-number"), 0)
})

test("toNullableNumber preserves NULL distinction (avg over zero rows)", () => {
  assert.equal(toNullableNumber(null), null)
  assert.equal(toNullableNumber(undefined), null)
  assert.equal(toNullableNumber("1.2345"), 1.2345)
  assert.equal(toNullableNumber(7), 7)
})

test("toDistribution returns {} for missing or non-object payloads", () => {
  assert.deepEqual(toDistribution(null), {})
  assert.deepEqual(toDistribution(undefined), {})
  assert.deepEqual(toDistribution([]), {})
  assert.deepEqual(toDistribution("not-json"), {})
})

test("toDistribution preserves slug→count integer maps", () => {
  assert.deepEqual(toDistribution({ bug: 5, performance: 2, unclassified: 1 }), {
    bug: 5,
    performance: 2,
    unclassified: 1,
  })
})

test("toPhrases drops malformed entries and keeps slug+phrase+count tuples", () => {
  const out = toPhrases([
    { slug: "model-quality", phrase: "hallucinate", count: 4 },
    { slug: "model-quality", phrase: "wrong answer", count: "2" }, // Postgres int-as-string
    { slug: "bug", phrase: 42, count: 1 }, // non-string phrase → skipped
    { slug: "bug", count: 9 }, // missing phrase → skipped
    null, // null entry → skipped
  ])
  assert.deepEqual(out, [
    { slug: "model-quality", phrase: "hallucinate", count: 4 },
    { slug: "model-quality", phrase: "wrong answer", count: 2 },
  ])
})

test("toPhrases falls back to 'unknown' slug when slug is missing or empty", () => {
  const out = toPhrases([
    { phrase: "hallucinate", count: 1 }, // missing slug
    { slug: "", phrase: "wrong answer", count: 1 }, // empty slug
    { slug: 7, phrase: "third", count: 1 }, // non-string slug
  ])
  assert.deepEqual(out, [
    { slug: "unknown", phrase: "hallucinate", count: 1 },
    { slug: "unknown", phrase: "wrong answer", count: 1 },
    { slug: "unknown", phrase: "third", count: 1 },
  ])
})

test("rowToMetadata maps the full MV row including NUMERIC strings", () => {
  const row = {
    cluster_id: "c-1",
    cluster_key: "semantic:abc",
    cluster_path: "semantic",
    observation_count: 10,
    classified_count: 8,
    unclassified_count: 2,
    classification_coverage_share: "0.8000",
    topic_distribution: { bug: 6, performance: 2, unclassified: 2 },
    runner_up_distribution: { bug: 2 },
    dominant_topic_slug: "bug",
    dominant_topic_count: 6,
    dominant_topic_share: "0.6000",
    avg_confidence_proxy: "0.4250",
    avg_topic_margin: "3.5000",
    low_margin_count: 1,
    mixed_topic_score: "0.4500",
    common_matched_phrases: [
      { slug: "model-quality", phrase: "hallucinate", count: 3 },
      { slug: "model-quality", phrase: "wrong answer", count: 2 },
    ],
    computed_at: "2026-04-28T00:00:00Z",
  }

  const out = rowToMetadata(row)

  assert.equal(out.cluster_id, "c-1")
  assert.equal(out.cluster_path, "semantic")
  assert.equal(out.observation_count, 10)
  assert.equal(out.classified_count, 8)
  assert.equal(out.unclassified_count, 2)
  assert.equal(out.classification_coverage_share, 0.8)
  assert.deepEqual(out.topic_distribution, { bug: 6, performance: 2, unclassified: 2 })
  assert.deepEqual(out.runner_up_distribution, { bug: 2 })
  assert.equal(out.dominant_topic_slug, "bug")
  assert.equal(out.dominant_topic_count, 6)
  assert.equal(out.dominant_topic_share, 0.6)
  assert.equal(out.avg_confidence_proxy, 0.425)
  assert.equal(out.avg_topic_margin, 3.5)
  assert.equal(out.low_margin_count, 1)
  assert.equal(out.mixed_topic_score, 0.45)
  assert.deepEqual(out.common_matched_phrases, [
    { slug: "model-quality", phrase: "hallucinate", count: 3 },
    { slug: "model-quality", phrase: "wrong answer", count: 2 },
  ])
})

test("rowToMetadata falls back to fallback path when cluster_path is missing", () => {
  const row = {
    cluster_id: "c-2",
    cluster_key: "title:abc",
    cluster_path: null,
    observation_count: 0,
    classified_count: 0,
    unclassified_count: 0,
    classification_coverage_share: "0.0000",
    topic_distribution: {},
    runner_up_distribution: {},
    dominant_topic_slug: null,
    dominant_topic_count: null,
    dominant_topic_share: "0.0000",
    avg_confidence_proxy: null,
    avg_topic_margin: null,
    low_margin_count: 0,
    mixed_topic_score: "0.0000",
    common_matched_phrases: [],
    computed_at: "2026-04-28T00:00:00Z",
  }

  const out = rowToMetadata(row)
  assert.equal(out.cluster_path, "fallback")
  // NULL aggregates (avg over zero contributing rows) survive as null
  // rather than being silently coerced to 0 — the distinction matters
  // for "this cluster has no current-version evidence yet" surfaces.
  assert.equal(out.avg_confidence_proxy, null)
  assert.equal(out.avg_topic_margin, null)
  assert.equal(out.dominant_topic_slug, null)
  assert.equal(out.dominant_topic_share, 0)
  assert.equal(out.classification_coverage_share, 0)
})
