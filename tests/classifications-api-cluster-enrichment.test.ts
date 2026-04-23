import test from "node:test"
import assert from "node:assert/strict"

// Pure-function characterization of the cluster-enrichment merge in
// app/api/classifications/route.ts. The route fans out three parallel
// Supabase queries (classifications → mv_observation_current → clusters +
// cluster_members) and merges the results onto each classification row.
//
// These tests lock the merge contract:
//   - Member count is the number of active (detached_at IS NULL) rows in
//     cluster_members for that cluster_id.
//   - An observation with no cluster_id yields null cluster fields on the
//     response row (the UI hides the detail panel's cluster block and
//     excludes the row from the semantic-cluster chip strip).
//   - A classification with no observation_id yields null cluster fields
//     (the classification is cluster-less by construction).
//   - A cluster that has rows in `clusters` but no active member rows is
//     reported with size=0 (data-integrity edge case; UI still renders
//     the label so reviewers can see the cluster exists).

interface ClassificationRow {
  id: string
  observation_id: string | null
}

interface ObservationRow {
  observation_id: string
  cluster_id: string | null
  cluster_key: string | null
}

interface ClusterRow {
  id: string
  cluster_key: string
  label: string | null
  label_confidence: number | null
}

interface MemberRow {
  cluster_id: string
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
  members: MemberRow[],
): EnrichedRow[] {
  const observationMap = new Map<string, ObservationRow>()
  for (const o of observations) observationMap.set(o.observation_id, o)

  const memberCountByCluster = new Map<string, number>()
  for (const m of members) {
    memberCountByCluster.set(m.cluster_id, (memberCountByCluster.get(m.cluster_id) ?? 0) + 1)
  }

  const clusterMap = new Map<
    string,
    { label: string | null; label_confidence: number | null; size: number }
  >()
  for (const c of clusters) {
    clusterMap.set(c.id, {
      label: c.label ?? null,
      label_confidence: c.label_confidence ?? null,
      size: memberCountByCluster.get(c.id) ?? 0,
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
      cluster_size: cluster?.size ?? null,
    }
  })
}

test("enrichment attaches label, confidence, and active member count to clustered rows", () => {
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [{ observation_id: "obs-1", cluster_id: "c-1", cluster_key: "semantic:abc" }],
    [{ id: "c-1", cluster_key: "semantic:abc", label: "Repo scan hangs", label_confidence: 0.82 }],
    [{ cluster_id: "c-1" }, { cluster_id: "c-1" }, { cluster_id: "c-1" }],
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
    [{ observation_id: "obs-1", cluster_id: null, cluster_key: null }],
    [],
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
    [],
  )
  assert.equal(result[0].cluster_id, null)
  assert.equal(result[0].cluster_size, null)
})

test("enrichment reports size=0 when a cluster exists but has no active members", () => {
  // Data-integrity edge case: all members were detached (detached_at
  // is not null in cluster_members) but the clusters row is still live.
  // Size=0 is the correct reading and lets the UI still show the label.
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [{ observation_id: "obs-1", cluster_id: "c-1", cluster_key: "semantic:abc" }],
    [{ id: "c-1", cluster_key: "semantic:abc", label: "Empty cluster", label_confidence: 0.5 }],
    [],
  )
  assert.equal(result[0].cluster_size, 0)
  assert.equal(result[0].cluster_label, "Empty cluster")
})

test("enrichment leaves cluster fields null when observation references a cluster_id not in the clusters fetch", () => {
  // Can happen mid-cluster-rebuild when cluster_id on the MV is stale
  // relative to the clusters table. Null is strictly safer than
  // guessing, and the UI treats null labels with the "Unlabelled
  // cluster" placeholder anyway.
  const result = enrichWithClusters(
    [{ id: "cls-1", observation_id: "obs-1" }],
    [{ observation_id: "obs-1", cluster_id: "c-1", cluster_key: "semantic:abc" }],
    [], // clusters fetch missed this id
    [],
  )
  assert.equal(result[0].cluster_id, "c-1")
  assert.equal(result[0].cluster_key, "semantic:abc")
  assert.equal(result[0].cluster_label, null)
  assert.equal(result[0].cluster_label_confidence, null)
  assert.equal(result[0].cluster_size, null)
})

test("enrichment counts only the passed member rows per cluster (caller filters detached)", () => {
  // The route passes `.is("detached_at", null)` to Supabase, so detached
  // members never reach this function. The function therefore counts
  // verbatim — no filtering logic baked in here.
  const result = enrichWithClusters(
    [
      { id: "cls-1", observation_id: "obs-1" },
      { id: "cls-2", observation_id: "obs-2" },
    ],
    [
      { observation_id: "obs-1", cluster_id: "c-1", cluster_key: "semantic:a" },
      { observation_id: "obs-2", cluster_id: "c-2", cluster_key: "semantic:b" },
    ],
    [
      { id: "c-1", cluster_key: "semantic:a", label: "A", label_confidence: 0.9 },
      { id: "c-2", cluster_key: "semantic:b", label: "B", label_confidence: 0.7 },
    ],
    [
      { cluster_id: "c-1" },
      { cluster_id: "c-1" },
      { cluster_id: "c-2" },
      { cluster_id: "c-2" },
      { cluster_id: "c-2" },
    ],
  )
  assert.equal(result[0].cluster_size, 2)
  assert.equal(result[1].cluster_size, 3)
})

test("enrichment preserves the cluster_key prefix so UI can distinguish semantic vs title-hash fallback", () => {
  // `semantic:<digest>` means real embedding-based clustering fired.
  // `title:<md5>` means the fallback path fired (embedding failure or
  // below-threshold similarity). The API returns the prefix verbatim;
  // the UI hides it behind a title= tooltip per the plan.
  const result = enrichWithClusters(
    [
      { id: "cls-1", observation_id: "obs-1" },
      { id: "cls-2", observation_id: "obs-2" },
    ],
    [
      { observation_id: "obs-1", cluster_id: "c-sem", cluster_key: "semantic:abc123" },
      { observation_id: "obs-2", cluster_id: "c-tit", cluster_key: "title:def456" },
    ],
    [
      { id: "c-sem", cluster_key: "semantic:abc123", label: "labelled", label_confidence: 0.9 },
      { id: "c-tit", cluster_key: "title:def456", label: null, label_confidence: null },
    ],
    [{ cluster_id: "c-sem" }, { cluster_id: "c-tit" }],
  )
  assert.ok(result[0].cluster_key?.startsWith("semantic:"))
  assert.ok(result[1].cluster_key?.startsWith("title:"))
})
