import test from "node:test"
import assert from "node:assert/strict"

import {
  aggregateClusters,
  type ClusterLabelRow,
  type ClusterObservationRow,
} from "../lib/classification/clusters.ts"

// Pure-function tests for the /api/clusters aggregation. Imports the
// real helper so drift between test and route handler is caught by
// `tsc`. The route calls aggregateClusters(rows, labels, {limit, samplesPerCluster});
// these tests lock the invariants it's expected to maintain.
//
// Supersedes the client-side `computeSemanticClusters` tests from the
// previous PR — the aggregation moved server-side so the chip strip can
// render independent of the classification pipeline (user-visible bug:
// "66 clustered observations, 0 chips" when classify-backfill hadn't
// run against the impact-score gate). See docs/CLUSTERING_DESIGN.md §7.

const mkRow = (partial: Partial<ClusterObservationRow>): ClusterObservationRow => ({
  observation_id: "obs-1",
  title: "Sample title",
  url: null,
  cluster_id: "c-1",
  cluster_key: "semantic:c-1",
  llm_classified_at: null,
  frequency_count: 2,
  impact_score: 5,
  sentiment: null,
  ...partial,
})

const mkLabel = (partial: Partial<ClusterLabelRow>): ClusterLabelRow => ({
  id: "c-1",
  cluster_key: "semantic:c-1",
  label: "Sample label",
  label_confidence: 0.8,
  ...partial,
})

// --- grouping invariants -----------------------------------------------------

test("aggregateClusters groups observations by cluster_id and counts in_window", () => {
  const rows = [
    mkRow({ observation_id: "o1", cluster_id: "c1", cluster_key: "semantic:c1", frequency_count: 7 }),
    mkRow({ observation_id: "o2", cluster_id: "c1", cluster_key: "semantic:c1", frequency_count: 7 }),
    mkRow({ observation_id: "o3", cluster_id: "c2", cluster_key: "semantic:c2", frequency_count: 3 }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.equal(result.length, 2)
  assert.equal(result.find((c) => c.id === "c1")?.in_window, 2)
  assert.equal(result.find((c) => c.id === "c2")?.in_window, 1)
})

test("aggregateClusters skips rows with a null cluster_id", () => {
  // A canonical observation without cluster membership shouldn't
  // invent a bucket — the route still returns such rows from the MV
  // and the helper must ignore them.
  const rows = [mkRow({ cluster_id: null, cluster_key: null })]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.deepEqual(result, [])
})

test("aggregateClusters captures frequency_count as size, window-independent", () => {
  // The MV's frequency_count is total active membership regardless of
  // time window. A cluster with 2 in-window obs but 50 total still
  // reports size=50; the chip strip uses both ("2 here · 50 total").
  const rows = [
    mkRow({ observation_id: "o1", cluster_id: "c1", cluster_key: "semantic:c1", frequency_count: 50 }),
    mkRow({ observation_id: "o2", cluster_id: "c1", cluster_key: "semantic:c1", frequency_count: 50 }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.equal(result[0].size, 50)
  assert.equal(result[0].in_window, 2)
})

test("aggregateClusters counts classified_count from llm_classified_at", () => {
  // Tells the UI how many of this cluster's visible members would
  // actually appear in the triage queue below the chip strip.
  const rows = [
    mkRow({ observation_id: "o1", cluster_id: "c1", cluster_key: "semantic:c1", llm_classified_at: "2026-04-22T00:00:00Z" }),
    mkRow({ observation_id: "o2", cluster_id: "c1", cluster_key: "semantic:c1", llm_classified_at: null }),
    mkRow({ observation_id: "o3", cluster_id: "c1", cluster_key: "semantic:c1", llm_classified_at: "2026-04-23T00:00:00Z" }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.equal(result[0].classified_count, 2)
  assert.equal(result[0].in_window, 3)
})

// --- sorting + limit ---------------------------------------------------------

test("aggregateClusters sorts by in_window DESC with size DESC as tiebreaker", () => {
  // Tiebreaker matters: two clusters with the same in_window count
  // should not flip order randomly. Larger-total cluster wins the tie
  // so high-impact clusters stay near the front when scope narrows.
  const rows = [
    mkRow({ observation_id: "o1", cluster_id: "small", cluster_key: "semantic:small", frequency_count: 2 }),
    mkRow({ observation_id: "o2", cluster_id: "big", cluster_key: "semantic:big", frequency_count: 40 }),
    mkRow({ observation_id: "o3", cluster_id: "big", cluster_key: "semantic:big", frequency_count: 40 }),
    mkRow({ observation_id: "o4", cluster_id: "big", cluster_key: "semantic:big", frequency_count: 40 }),
    mkRow({ observation_id: "o5", cluster_id: "medA", cluster_key: "semantic:medA", frequency_count: 20 }),
    mkRow({ observation_id: "o6", cluster_id: "medA", cluster_key: "semantic:medA", frequency_count: 20 }),
    mkRow({ observation_id: "o7", cluster_id: "medB", cluster_key: "semantic:medB", frequency_count: 5 }),
    mkRow({ observation_id: "o8", cluster_id: "medB", cluster_key: "semantic:medB", frequency_count: 5 }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.deepEqual(
    result.map((c) => c.id),
    ["big", "medA", "medB", "small"],
  )
})

test("aggregateClusters honours the limit parameter", () => {
  const rows = Array.from({ length: 15 }, (_, i) =>
    mkRow({
      observation_id: `o${i}`,
      cluster_id: `c${i}`,
      cluster_key: `semantic:c${i}`,
      frequency_count: 3,
    }),
  )
  const result = aggregateClusters(rows, [], { limit: 5, samplesPerCluster: 3 })
  assert.equal(result.length, 5)
})

// --- title-hash filtering (data-scientist review H2 carried forward) --------

test("aggregateClusters drops title:<md5> singletons — pure chip noise", () => {
  const rows = [
    mkRow({ cluster_id: "t1", cluster_key: "title:abc", frequency_count: 1 }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.deepEqual(result, [])
})

test("aggregateClusters keeps title: clusters that accumulated >=2 members", () => {
  // Two reports with the exact same normalised title produce a real
  // title-hash cluster that still carries signal.
  const rows = [
    mkRow({ observation_id: "o1", cluster_id: "td", cluster_key: "title:ddd", frequency_count: 2 }),
    mkRow({ observation_id: "o2", cluster_id: "td", cluster_key: "title:ddd", frequency_count: 2 }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "td")
})

test("aggregateClusters keeps semantic: clusters even as singletons", () => {
  // A semantic:-keyed cluster means the embedding path fired and
  // found a grouping at some point. Size-1 means other members were
  // detached but the cluster carries meaningful triage signal.
  const rows = [
    mkRow({ observation_id: "o1", cluster_id: "cs", cluster_key: "semantic:cs", frequency_count: 1 }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.equal(result.length, 1)
})

// --- samples ----------------------------------------------------------------

test("aggregateClusters collects up to samplesPerCluster titles in input order", () => {
  // Rows arrive pre-sorted by impact_score DESC. The first N rows per
  // cluster become the samples, so the UI preview shows top-impact
  // members first.
  const rows = [
    mkRow({ observation_id: "o-top", cluster_id: "c1", cluster_key: "semantic:c1", impact_score: 9.5, title: "Top" }),
    mkRow({ observation_id: "o-mid", cluster_id: "c1", cluster_key: "semantic:c1", impact_score: 7.1, title: "Mid" }),
    mkRow({ observation_id: "o-low", cluster_id: "c1", cluster_key: "semantic:c1", impact_score: 4.2, title: "Low" }),
    mkRow({ observation_id: "o-extra", cluster_id: "c1", cluster_key: "semantic:c1", impact_score: 2.0, title: "Extra" }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.equal(result[0].samples.length, 3)
  assert.deepEqual(
    result[0].samples.map((s) => s.observation_id),
    ["o-top", "o-mid", "o-low"],
  )
})

test("aggregateClusters defaults a missing title to 'Untitled observation'", () => {
  const rows = [
    mkRow({ cluster_id: "c1", cluster_key: "semantic:c1", title: null, frequency_count: 2 }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.equal(result[0].samples[0].title, "Untitled observation")
})

// --- labels -----------------------------------------------------------------

test("aggregateClusters joins label + confidence from the labels input", () => {
  const rows = [
    mkRow({ cluster_id: "c1", cluster_key: "semantic:c1", frequency_count: 2 }),
  ]
  const labels = [
    mkLabel({ id: "c1", cluster_key: "semantic:c1", label: "Repo scan hangs", label_confidence: 0.82 }),
  ]
  const result = aggregateClusters(rows, labels, { limit: 10, samplesPerCluster: 3 })
  assert.equal(result[0].label, "Repo scan hangs")
  assert.equal(result[0].label_confidence, 0.82)
})

test("aggregateClusters leaves label fields null when the labels input omits a cluster_id", () => {
  // Mid-rebuild when cluster_id in the MV is stale relative to the
  // clusters table — keep the cluster so the user can still see its
  // members via the chip click, just render "Unlabelled cluster" in
  // the UI.
  const rows = [
    mkRow({ cluster_id: "cOrphan", cluster_key: "semantic:cOrphan", frequency_count: 2 }),
  ]
  const result = aggregateClusters(rows, [], { limit: 10, samplesPerCluster: 3 })
  assert.equal(result.length, 1)
  assert.equal(result[0].label, null)
  assert.equal(result[0].label_confidence, null)
})
