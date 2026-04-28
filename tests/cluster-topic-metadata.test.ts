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

test("toPhrases drops malformed entries and keeps phrase+count tuples", () => {
  const out = toPhrases([
    { phrase: "hallucinate", count: 4 },
    { phrase: "wrong answer", count: "2" }, // Postgres int-as-string
    { phrase: 42, count: 1 }, // non-string phrase → skipped
    { count: 9 }, // missing phrase → skipped
    null, // null entry → skipped
  ])
  assert.deepEqual(out, [
    { phrase: "hallucinate", count: 4 },
    { phrase: "wrong answer", count: 2 },
  ])
})

test("rowToMetadata maps the full MV row including NUMERIC strings", () => {
  const row = {
    cluster_id: "c-1",
    cluster_key: "semantic:abc",
    cluster_path: "semantic",
    observation_count: 10,
    classified_count: 8,
    other_count: 2,
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
      { phrase: "hallucinate", count: 3 },
      { phrase: "wrong answer", count: 2 },
    ],
    computed_at: "2026-04-28T00:00:00Z",
  }

  const out = rowToMetadata(row)

  assert.equal(out.cluster_id, "c-1")
  assert.equal(out.cluster_path, "semantic")
  assert.equal(out.observation_count, 10)
  assert.equal(out.classified_count, 8)
  assert.equal(out.other_count, 2)
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
    { phrase: "hallucinate", count: 3 },
    { phrase: "wrong answer", count: 2 },
  ])
})

test("rowToMetadata falls back to fallback path when cluster_path is missing", () => {
  const row = {
    cluster_id: "c-2",
    cluster_key: "title:abc",
    cluster_path: null,
    observation_count: 0,
    classified_count: 0,
    other_count: 0,
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
  // for "this cluster has no v5 evidence yet" surfaces.
  assert.equal(out.avg_confidence_proxy, null)
  assert.equal(out.avg_topic_margin, null)
  assert.equal(out.dominant_topic_slug, null)
  assert.equal(out.dominant_topic_share, 0)
})
