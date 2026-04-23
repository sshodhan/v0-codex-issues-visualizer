import test from "node:test"
import assert from "node:assert/strict"

// Pure-function characterization of the cluster-enrichment merge in
// app/api/classifications/route.ts. The route fans out two parallel
// Supabase queries (classifications → mv_observation_current) and then
// issues one extra serial query (clusters) once observation cluster ids
// are known. Member count is not re-derived — it comes from
// `mv_observation_current.frequency_count`, backed by the
// `cluster_frequency` view in scripts/007_three_layer_split.sql (which
// already counts members where `detached_at IS NULL`).
//
// These tests lock the merge contract:
//   - cluster_size is the observation's `frequency_count` when cluster_id
//     is present; null otherwise.
//   - An observation with no cluster_id yields null cluster fields on the
//     response row (UI hides the detail panel's cluster block and excludes
//     the row from the semantic-cluster chip strip).
//   - A classification with no observation_id yields null cluster fields.
//   - A cluster_id referenced by an observation but missing from the
//     `clusters` fetch (mid-rebuild) yields null label fields but keeps
//     cluster_id/cluster_key so the UI can still apply the "semantic:"
//     filter.
//   - cluster_key prefix (`semantic:` vs `title:`) is preserved so the UI
//     can hide title-hash fallback singletons from the chip strip.

interface ClassificationRow {
  id: string
  observation_id: string | null
}

interface ObservationRow {
  observation_id: string
  cluster_id: string | null
  cluster_key: string | null
  frequency_count: number | null
}

interface ClusterRow {
  id: string
  cluster_key: string
  label: string | null
  label_confidence: number | null
}

interface EnrichedRow {
  id: string
  observation_id: string | null
  cluster_id: string | null
  cluster_key: string | null
  cluster_label: string | null
  cluster_label_confidence: number | null
  cluster_size: number | null
}

// Mirror of the merge in app/api/classifications/route.ts. Kept
// deliberately close to the route's structure so drift is obvious on
// review.
function enrichWithClusters(
  classifications: ClassificationRow[],
  observations: ObservationRow[],
  clusters: ClusterRow[],
): EnrichedRow[] {
  const observationMap = new Map<string, ObservationRow>()
  for (const o of observations) observationMap.set(o.observation_id, o)

  const clusterMap = new Map<
    string,
    { label: string | null; label_confidence: number | null }
  >()
  for (const c of clusters) {
    clusterMap.set(c.id, {
      label: c.label ?? null,
      label_confidence: c.label_confidence ?? null,
    })
  }

  return classifications.map((row) => {
    const obs = row.observation_id ? observationMap.get(row.observation_id) ?? null : null
    const cluster = obs?.cluster_id ? clusterMap.get(obs.cluster_id) ?? null : null
    return {
      id: row.id,
      observation_id: row.observation_id,
      cluster_id: obs?.cluster_id ?? null,
      cluster_key: obs?.cluster_key ?? null,
      cluster_label: cluster?.label ?? null,
      cluster_label_confidence: cluster?.label_confidence ?? null,
      cluster_size: obs?.cluster_id ? Number(obs?.frequency_count ?? 0) : null,
    }
  })
}

test("enrichment attaches label, confidence, and frequency_count to clustered rows", () => {
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [
      {
        observation_id: "obs-1",
        cluster_id: "c-1",
        cluster_key: "semantic:abc",
        frequency_count: 3,
      },
    ],
    [{ id: "c-1", cluster_key: "semantic:abc", label: "Repo scan hangs", label_confidence: 0.82 }],
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].cluster_id, "c-1")
  assert.equal(result[0].cluster_key, "semantic:abc")
  assert.equal(result[0].cluster_label, "Repo scan hangs")
  assert.equal(result[0].cluster_label_confidence, 0.82)
  assert.equal(result[0].cluster_size, 3)
})

test("enrichment returns all-null cluster fields when the observation has no cluster_id", () => {
  // Happens when clustering hasn't run on this observation yet, embedding
  // failed, or the observation landed in the fallback path with a null
  // cluster_id. The UI must render this row without the detail-panel
  // cluster block and without counting it in the chip strip.
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [{ observation_id: "obs-1", cluster_id: null, cluster_key: null, frequency_count: null }],
    [],
  )
  assert.equal(result[0].cluster_id, null)
  assert.equal(result[0].cluster_key, null)
  assert.equal(result[0].cluster_label, null)
  assert.equal(result[0].cluster_label_confidence, null)
  assert.equal(result[0].cluster_size, null)
})

test("enrichment returns all-null cluster fields when the classification has no observation_id", () => {
  // Pre-traceability or orphaned classifications exist in the schema
  // and must not blow up the merge.
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: null }],
    [],
    [],
  )
  assert.equal(result[0].cluster_id, null)
  assert.equal(result[0].cluster_size, null)
})

test("enrichment reports cluster_size=0 when frequency_count is 0 (edge case: all members detached)", () => {
  // Data-integrity edge: cluster_frequency view returns 0 (or null coerced
  // to 0) when every member of a cluster has been detached. The label
  // still renders so reviewers can see the cluster historically existed.
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [
      {
        observation_id: "obs-1",
        cluster_id: "c-1",
        cluster_key: "semantic:abc",
        frequency_count: 0,
      },
    ],
    [{ id: "c-1", cluster_key: "semantic:abc", label: "Empty cluster", label_confidence: 0.5 }],
  )
  assert.equal(result[0].cluster_size, 0)
  assert.equal(result[0].cluster_label, "Empty cluster")
})

test("enrichment coerces null frequency_count to 0 when the observation has a cluster_id", () => {
  // Defensive: if the MV returns null frequency_count for a clustered
  // observation (should not happen but has been observed in partial MV
  // refreshes), cluster_size is 0, not null. Null would be indistinguishable
  // from "no cluster" downstream.
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [
      {
        observation_id: "obs-1",
        cluster_id: "c-1",
        cluster_key: "semantic:abc",
        frequency_count: null,
      },
    ],
    [{ id: "c-1", cluster_key: "semantic:abc", label: "x", label_confidence: 0.8 }],
  )
  assert.equal(result[0].cluster_size, 0)
})

test("enrichment leaves label fields null when observation references a cluster_id not in the clusters fetch", () => {
  // Can happen mid-cluster-rebuild when cluster_id on the MV is stale
  // relative to the clusters table. Keep cluster_id + cluster_key + size
  // (so the UI's title: filter still works), null out label fields.
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [
      {
        observation_id: "obs-1",
        cluster_id: "c-1",
        cluster_key: "semantic:abc",
        frequency_count: 2,
      },
    ],
    [], // clusters fetch missed this id
  )
  assert.equal(result[0].cluster_id, "c-1")
  assert.equal(result[0].cluster_key, "semantic:abc")
  assert.equal(result[0].cluster_label, null)
  assert.equal(result[0].cluster_label_confidence, null)
  assert.equal(result[0].cluster_size, 2)
})

test("enrichment preserves cluster_key prefix so UI can distinguish semantic vs title-hash fallback", () => {
  // `semantic:<digest>` means real embedding-based clustering fired.
  // `title:<md5>` means the fallback path fired (embedding failure or
  // below-threshold similarity). The API returns the prefix verbatim;
  // the UI uses it to hide `title:` singletons from the chip strip
  // (data-scientist review H2). Never rendered to users.
  const result = enrichWithClusters(
    [
      { id: "cls-1", observation_id: "obs-1" },
      { id: "cls-2", observation_id: "obs-2" },
    ],
    [
      {
        observation_id: "obs-1",
        cluster_id: "c-sem",
        cluster_key: "semantic:abc123",
        frequency_count: 5,
      },
      {
        observation_id: "obs-2",
        cluster_id: "c-tit",
        cluster_key: "title:def456",
        frequency_count: 1,
      },
    ],
    [
      { id: "c-sem", cluster_key: "semantic:abc123", label: "labelled", label_confidence: 0.9 },
      { id: "c-tit", cluster_key: "title:def456", label: null, label_confidence: null },
    ],
  )
  assert.ok(result[0].cluster_key?.startsWith("semantic:"))
  assert.ok(result[1].cluster_key?.startsWith("title:"))
})

test("enrichment tolerates duplicate cluster rows — last write wins without throwing", () => {
  // The Supabase .in() query should return at most one row per id by
  // uniqueness, but an imperfect view or a future join change could
  // produce duplicates. The merge must not crash and must pick a
  // deterministic winner (last occurrence).
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [
      {
        observation_id: "obs-1",
        cluster_id: "c-1",
        cluster_key: "semantic:abc",
        frequency_count: 2,
      },
    ],
    [
      { id: "c-1", cluster_key: "semantic:abc", label: "first", label_confidence: 0.5 },
      { id: "c-1", cluster_key: "semantic:abc", label: "second", label_confidence: 0.9 },
    ],
  )
  assert.equal(result[0].cluster_label, "second")
  assert.equal(result[0].cluster_label_confidence, 0.9)
})

test("enrichment tolerates an observation_id that does not resolve to an observation row", () => {
  // Covers the race where a classification references an observation
  // that has been soft-deleted or not yet replicated into the MV. All
  // downstream cluster fields are null; no throw.
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-missing" }],
    [], // observation row missing
    [],
  )
  assert.equal(result[0].cluster_id, null)
  assert.equal(result[0].cluster_key, null)
  assert.equal(result[0].cluster_label, null)
  assert.equal(result[0].cluster_size, null)
})
