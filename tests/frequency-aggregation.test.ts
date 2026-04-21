import test from "node:test"
import assert from "node:assert/strict"

// Rewritten for the three-layer split (docs/ARCHITECTURE.md v10).
//
// Under the old design, frequency_count was a column on `issues` that an
// upsert incremented on duplicate (source_id, external_id) hits. Under the
// new design:
//
// - The observation row is append-only (one per (source_id, external_id));
//   rescrapes never overwrite it.
// - Engagement and content changes append to engagement_snapshots and
//   observation_revisions respectively.
// - Cluster volume (the old frequency_count) is derived from the active
//   set of cluster_members rows (detached_at IS NULL).
//
// This test exercises that contract in-memory.

interface ObservationRow {
  observation_id: string
  source_id: string
  external_id: string
  title: string
  captured_at: string
}

interface RevisionRow {
  observation_id: string
  revision_number: number
  title: string
  seen_at: string
}

interface EngagementRow {
  observation_id: string
  upvotes: number
  comments_count: number
  captured_at: string
}

interface ClusterMemberRow {
  cluster_id: string
  observation_id: string
  attached_at: string
  detached_at: string | null
}

class InMemoryStore {
  private observations = new Map<string, ObservationRow>()
  private revisions: RevisionRow[] = []
  private engagement: EngagementRow[] = []
  private members: ClusterMemberRow[] = []
  private nextId = 1

  recordObservation(payload: { source_id: string; external_id: string; title: string }, capturedAt: string): string {
    const key = `${payload.source_id}::${payload.external_id}`
    const existing = this.observations.get(key)
    if (existing) return existing.observation_id

    const id = `obs-${this.nextId++}`
    this.observations.set(key, {
      observation_id: id,
      source_id: payload.source_id,
      external_id: payload.external_id,
      title: payload.title,
      captured_at: capturedAt,
    })
    return id
  }

  recordRevision(observationId: string, title: string, seenAt: string) {
    const prior = this.revisions.filter((r) => r.observation_id === observationId)
    this.revisions.push({
      observation_id: observationId,
      revision_number: prior.length + 1,
      title,
      seen_at: seenAt,
    })
  }

  recordEngagement(observationId: string, upvotes: number, commentsCount: number, capturedAt: string) {
    this.engagement.push({
      observation_id: observationId,
      upvotes,
      comments_count: commentsCount,
      captured_at: capturedAt,
    })
  }

  attachToCluster(clusterId: string, observationId: string, attachedAt: string) {
    const active = this.members.find(
      (m) => m.cluster_id === clusterId && m.observation_id === observationId && m.detached_at === null,
    )
    if (active) return
    this.members.push({
      cluster_id: clusterId,
      observation_id: observationId,
      attached_at: attachedAt,
      detached_at: null,
    })
  }

  clusterFrequency(clusterId: string): number {
    return this.members.filter((m) => m.cluster_id === clusterId && m.detached_at === null).length
  }

  observation(source: string, external: string): ObservationRow | undefined {
    return this.observations.get(`${source}::${external}`)
  }

  revisionCount(observationId: string): number {
    return this.revisions.filter((r) => r.observation_id === observationId).length
  }

  engagementSnapshots(observationId: string): EngagementRow[] {
    return this.engagement.filter((e) => e.observation_id === observationId)
  }
}

test("observation is never mutated; revisions and engagement snapshots append", () => {
  const store = new InMemoryStore()

  // First scrape.
  const obsId = store.recordObservation(
    { source_id: "source-1", external_id: "abc-123", title: "First title" },
    "2026-04-21T00:00:00.000Z",
  )
  store.recordEngagement(obsId, 5, 2, "2026-04-21T00:00:00.000Z")
  store.attachToCluster("cluster-A", obsId, "2026-04-21T00:00:00.000Z")

  // Rescrape with edited title and growing engagement.
  const obsIdAgain = store.recordObservation(
    { source_id: "source-1", external_id: "abc-123", title: "Edited title" },
    "2026-04-21T00:05:00.000Z",
  )
  assert.equal(obsIdAgain, obsId, "same external post must collapse to the same observation")
  store.recordRevision(obsId, "Edited title", "2026-04-21T00:05:00.000Z")
  store.recordEngagement(obsId, 48, 10, "2026-04-21T00:05:00.000Z")

  // Third rescrape.
  store.recordObservation(
    { source_id: "source-1", external_id: "abc-123", title: "Edited title v2" },
    "2026-04-21T00:10:00.000Z",
  )
  store.recordRevision(obsId, "Edited title v2", "2026-04-21T00:10:00.000Z")
  store.recordEngagement(obsId, 202, 33, "2026-04-21T00:10:00.000Z")

  const captured = store.observation("source-1", "abc-123")!
  assert.ok(captured)
  assert.equal(captured.title, "First title", "observation title is frozen at first capture")
  assert.equal(captured.captured_at, "2026-04-21T00:00:00.000Z")

  assert.equal(store.revisionCount(obsId), 2, "two title edits produce two revision rows")
  const snapshots = store.engagementSnapshots(obsId)
  assert.equal(snapshots.length, 3, "three scrapes produce three engagement snapshots")
  assert.deepEqual(
    snapshots.map((s) => s.upvotes),
    [5, 48, 202],
    "engagement time series is preserved",
  )
})

test("cluster frequency is derived from active cluster_members, not stored on evidence", () => {
  const store = new InMemoryStore()

  const obsA = store.recordObservation(
    { source_id: "source-1", external_id: "a", title: "Codex hangs" },
    "2026-04-21T00:00:00.000Z",
  )
  const obsB = store.recordObservation(
    { source_id: "source-2", external_id: "b", title: "Codex hangs" },
    "2026-04-21T01:00:00.000Z",
  )
  const obsC = store.recordObservation(
    { source_id: "source-3", external_id: "c", title: "Codex hangs" },
    "2026-04-21T02:00:00.000Z",
  )

  store.attachToCluster("cluster-codex-hangs", obsA, "2026-04-21T00:00:00.000Z")
  store.attachToCluster("cluster-codex-hangs", obsB, "2026-04-21T01:00:00.000Z")
  store.attachToCluster("cluster-codex-hangs", obsC, "2026-04-21T02:00:00.000Z")
  // Re-attachment is idempotent.
  store.attachToCluster("cluster-codex-hangs", obsA, "2026-04-21T03:00:00.000Z")

  assert.equal(
    store.clusterFrequency("cluster-codex-hangs"),
    3,
    "three observations across three sources in the same cluster count as three",
  )
})
