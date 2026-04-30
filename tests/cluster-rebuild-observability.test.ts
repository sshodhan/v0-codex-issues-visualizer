import test from "node:test"
import assert from "node:assert/strict"

import {
  buildEmbeddingInputText,
  bucketKeyFor,
  clusterEmbeddings,
  HISTOGRAM_BUCKETS,
  percentile,
} from "../lib/storage/semantic-cluster-core.ts"

// ============================================================================
// bucketKeyFor — boundary semantics
// ============================================================================

test("bucketKeyFor: boundary values land in the bucket they meet, not the one below", () => {
  // The histogram contract is "≥ lower-bound" — so a value at exactly
  // 0.86 must land in the 0.86 bucket, not the 0.83 one. This is the
  // single most important property because the active threshold is
  // typically aligned to a bucket boundary.
  assert.equal(bucketKeyFor(0.86), "0.86")
  assert.equal(bucketKeyFor(0.83), "0.83")
  assert.equal(bucketKeyFor(0.95), "0.95")
  // Just-below-boundary values fall into the prior bucket.
  assert.equal(bucketKeyFor(0.8599), "0.83")
  assert.equal(bucketKeyFor(0.7499), "0.70")
})

test("bucketKeyFor: values above the largest bucket still bucket into the largest", () => {
  assert.equal(bucketKeyFor(1.0), "0.95")
  assert.equal(bucketKeyFor(0.99), "0.95")
})

test("bucketKeyFor: low and zero values land in the smallest bucket", () => {
  assert.equal(bucketKeyFor(0.0), "0.00")
  assert.equal(bucketKeyFor(0.49), "0.00")
  // Defensive: negative inputs are never expected (callers count them
  // separately as "invalid"), but if they leak through they shouldn't
  // crash — they fall through to the smallest bucket.
  assert.equal(bucketKeyFor(-1), "0.00")
})

test("HISTOGRAM_BUCKETS is sorted ascending — required for bucketKeyFor's reverse loop", () => {
  for (let i = 1; i < HISTOGRAM_BUCKETS.length; i++) {
    assert.ok(
      HISTOGRAM_BUCKETS[i] > HISTOGRAM_BUCKETS[i - 1],
      `bucket[${i}]=${HISTOGRAM_BUCKETS[i]} must be > bucket[${i - 1}]=${HISTOGRAM_BUCKETS[i - 1]}`,
    )
  }
})

// ============================================================================
// percentile — empty / single / interpolation behavior
// ============================================================================

test("percentile: empty array returns null (UI renders '—')", () => {
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([], 0.95), null)
})

test("percentile: single-element array returns the only element regardless of p", () => {
  assert.equal(percentile([42], 0.0), 42)
  assert.equal(percentile([42], 0.5), 42)
  assert.equal(percentile([42], 1.0), 42)
})

test("percentile: nearest-rank on a known sequence", () => {
  // Inclusive nearest-rank: ceil(p*n) - 1 indexed into sorted array.
  // For [1,2,3,4,5] (n=5):
  //   p=0.5 → ceil(2.5)-1 = 2 → sorted[2] = 3 (the median)
  //   p=0.95 → ceil(4.75)-1 = 4 → sorted[4] = 5
  //   p=0.0 → max(0, ceil(0)-1) = 0 → sorted[0] = 1
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.0), 1)
  assert.equal(percentile([1, 2, 3, 4, 5], 1.0), 5)
})

test("percentile: unsorted input is sorted before ranking", () => {
  // Same sequence as above, just shuffled. Result must be identical
  // because the sort is internal — callers shouldn't have to pre-sort
  // their latency arrays.
  assert.equal(percentile([3, 1, 4, 5, 2], 0.5), 3)
  assert.equal(percentile([5, 4, 3, 2, 1], 0.95), 5)
})

// ============================================================================
// clusterEmbeddings — histogram correctness
// ============================================================================

function unitVec(parts: Record<number, number>, dim: number): number[] {
  // Build a `dim`-length vector with the specified non-zero entries,
  // then unit-normalize so cosine similarity is well-defined and
  // matches our expectations exactly. We can't just hand-craft vectors
  // and assume cosine-of-x; normalization is critical.
  const v = new Array<number>(dim).fill(0)
  for (const [idx, val] of Object.entries(parts)) {
    v[Number(idx)] = val
  }
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm === 0) return v
  return v.map((x) => x / norm)
}

test("clusterEmbeddings histogram: counts every pair exactly once and totals match n*(n-1)/2", () => {
  // 4 observations → 6 pairs. The histogram totalPairs MUST equal that
  // count; otherwise we're double-counting or skipping.
  const obs = [
    { id: "a", title: "a", embedding: [1, 0, 0] },
    { id: "b", title: "b", embedding: [1, 0, 0] },
    { id: "c", title: "c", embedding: [0, 1, 0] },
    { id: "d", title: "d", embedding: [0, 0, 1] },
  ]
  const result = clusterEmbeddings(obs, 0.86, 2)
  assert.equal(result.similarityHistogram.totalPairs, 6)

  let sumOfBucketCounts = 0
  for (const count of Object.values(result.similarityHistogram.buckets)) {
    sumOfBucketCounts += count
  }
  assert.equal(
    sumOfBucketCounts + result.similarityHistogram.invalid,
    result.similarityHistogram.totalPairs,
    "every pair must land in exactly one bucket OR be counted invalid",
  )
})

test("clusterEmbeddings histogram: identical embeddings land in the 0.95 bucket (sim=1.0)", () => {
  const obs = [
    { id: "a", title: "a", embedding: [1, 0, 0] },
    { id: "b", title: "b", embedding: [1, 0, 0] },
  ]
  const result = clusterEmbeddings(obs, 0.86, 2)
  assert.equal(result.similarityHistogram.buckets["0.95"], 1)
  assert.equal(result.similarityHistogram.totalPairs, 1)
})

test("clusterEmbeddings histogram: orthogonal embeddings land in the 0.00 bucket (sim=0)", () => {
  const obs = [
    { id: "a", title: "a", embedding: [1, 0, 0] },
    { id: "b", title: "b", embedding: [0, 1, 0] },
  ]
  const result = clusterEmbeddings(obs, 0.86, 2)
  assert.equal(result.similarityHistogram.buckets["0.00"], 1)
})

test("clusterEmbeddings histogram: zero-norm vectors increment `invalid`, not a bucket", () => {
  // cosineSimilarity returns -1 for zero-norm — that's the documented
  // failure mode, and the histogram must isolate those so they don't
  // contaminate the 0.00 bucket and look like "real but very low"
  // similarities.
  const obs = [
    { id: "a", title: "a", embedding: [0, 0, 0] },
    { id: "b", title: "b", embedding: [1, 0, 0] },
  ]
  const result = clusterEmbeddings(obs, 0.86, 2)
  assert.equal(result.similarityHistogram.invalid, 1)
  assert.equal(result.similarityHistogram.buckets["0.00"], 0)
})

test("clusterEmbeddings histogram: empty input yields all-zero buckets and totalPairs=0", () => {
  const result = clusterEmbeddings([], 0.86, 2)
  assert.equal(result.similarityHistogram.totalPairs, 0)
  assert.equal(result.similarityHistogram.invalid, 0)
  // All buckets must still be present at zero so the UI can render a
  // stable shape without conditional null-checks per bucket.
  for (const lo of HISTOGRAM_BUCKETS) {
    assert.equal(result.similarityHistogram.buckets[lo.toFixed(2)], 0)
  }
})

// ============================================================================
// buildEmbeddingInputText v2 — structured-prefix behavior
// ============================================================================

test("buildEmbeddingInputText v2: no signals → identical to v1 prose-only output", () => {
  // The v2 input format MUST be a strict superset of v1 — callers that
  // don't pass structured signals (legacy single-observation
  // recomputes from the trace-page Re-run button) must produce the
  // same byte-for-byte input as before so existing v1 embeddings can
  // still be reproduced if needed.
  const v1Like = buildEmbeddingInputText("My title", "My summary body")
  assert.equal(v1Like, "Title: My title\nSummary: My summary body")

  const v1LikeNoBody = buildEmbeddingInputText("My title", null)
  assert.equal(v1LikeNoBody, "Title: My title")
})

test("buildEmbeddingInputText v2: signals appear before Title in fixed order", () => {
  // Order MUST be Type → Error → Component → Stack → Platform.
  // This is a deterministic-output contract — same inputs always
  // produce same input text, so the embedding for an unchanged
  // observation is reproducible.
  const out = buildEmbeddingInputText("Issue title", "Issue body", {
    type: "bug",
    errorCode: "TIMEOUT",
    component: "codex-cli",
    topStackFrame: "tokio::runtime::block_on",
    platform: "windows",
  })
  assert.match(
    out,
    /^\[Type: bug\] \[Error: TIMEOUT\] \[Component: codex-cli\] \[Stack: tokio::runtime::block_on\] \[Platform: windows\]\nTitle: Issue title\nSummary: Issue body$/,
  )
})

test("buildEmbeddingInputText v2: null/undefined/empty signals are silently omitted", () => {
  // Cold-start observations only have some signals — the embedding
  // must still produce a valid input even when most of them are null.
  const out = buildEmbeddingInputText("T", "B", {
    type: "bug",
    errorCode: null,
    component: undefined,
    topStackFrame: "  ", // whitespace-only also dropped
    platform: "",
  })
  assert.equal(out, "[Type: bug]\nTitle: T\nSummary: B")
})

test("buildEmbeddingInputText v2: top stack frame truncated to 60 chars", () => {
  // Top stack frames can be long ("at /path/to/some/very/deep/module/with/lots/of/segments::function_name(line:col)").
  // We cap at 60 to keep the prefix bounded — embedding tokens are
  // expensive and the first part of a stack frame is usually the
  // discriminating module path.
  const longFrame = "a".repeat(120)
  const out = buildEmbeddingInputText("T", null, { topStackFrame: longFrame })
  const match = out.match(/\[Stack: (a+)\]/)
  assert.ok(match, "expected [Stack: ...] tag in output")
  assert.equal(match![1].length, 60)
})

test("buildEmbeddingInputText v2: empty signals object → identical to no-signals call", () => {
  // Defensive: passing {} (e.g. all signals queried but all null)
  // must produce the same output as not passing the third arg at all.
  const a = buildEmbeddingInputText("T", "B", {})
  const b = buildEmbeddingInputText("T", "B")
  assert.equal(a, b)
})

test("clusterEmbeddings histogram: known bucket placement at boundaries", () => {
  // Build vectors such that a-b have cosine ≈ 0.86 (boundary) and
  // a-c have cosine ≈ 0.5. Verify they land in the right buckets.
  // At dim=4: vec(1,0,0,0) and vec(cos(θ), sin(θ), 0, 0) have cos sim
  // = cos(θ). Use θ such that cos(θ) ≈ 0.87 (just above 0.86 boundary).
  const a = unitVec({ 0: 1 }, 4)
  // 0.87 above the 0.86 boundary, 0.55 above the 0.50 boundary
  const b = unitVec({ 0: 0.87, 1: Math.sqrt(1 - 0.87 * 0.87) }, 4)
  const c = unitVec({ 0: 0.55, 1: Math.sqrt(1 - 0.55 * 0.55) }, 4)
  const obs = [
    { id: "a", title: "a", embedding: a },
    { id: "b", title: "b", embedding: b },
    { id: "c", title: "c", embedding: c },
  ]
  const result = clusterEmbeddings(obs, 0.95, 2) // high threshold so no merges
  // a-b similarity ≈ 0.87 → 0.86 bucket
  // a-c similarity ≈ 0.55 → 0.50 bucket
  // b-c similarity ≈ cos(θ_a-c - θ_a-b) ≈ varies, check totalPairs only
  assert.equal(result.similarityHistogram.totalPairs, 3)
  assert.ok(
    result.similarityHistogram.buckets["0.86"] >= 1,
    "a-b at sim≈0.87 must land in the 0.86 bucket",
  )
  assert.ok(
    result.similarityHistogram.buckets["0.50"] >= 1,
    "a-c at sim≈0.55 must land in the 0.50 bucket",
  )
})
