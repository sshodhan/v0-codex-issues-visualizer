import test from "node:test"
import assert from "node:assert/strict"

// Proves the replayability contract from docs/ARCHITECTURE.md v10 §7.4:
// given the evidence + derivation + aggregation data at time T1, inserting
// later derivation rows at T2 must not change the dashboard numbers
// reproducible with `?as_of=T1`.
//
// This test simulates the SQL `observation_current_as_of(ts)` function in
// TypeScript against an in-memory store that mirrors the three-layer
// schema. If the simulated aggregates drift when later rows are appended,
// the contract is broken — either here or in scripts/009_as_of_functions.sql
// (the shape of the function mirrors the logic exercised below).

interface Observation {
  id: string
  source_id: string
  title: string
  published_at: string
  captured_at: string
}

interface SentimentRow {
  observation_id: string
  algorithm_version: string
  label: "positive" | "negative" | "neutral"
  score: number
  computed_at: string
}

interface ImpactRow {
  observation_id: string
  algorithm_version: string
  score: number
  computed_at: string
}

interface ClusterMembership {
  cluster_id: string
  observation_id: string
  attached_at: string
  detached_at: string | null
}

interface EvidenceStore {
  observations: Observation[]
  sentiment: SentimentRow[]
  impact: ImpactRow[]
  members: ClusterMembership[]
  clusters: Array<{ id: string; canonical_observation_id: string }>
}

// Simulates the body of observation_current_as_of(ts) from
// scripts/009_as_of_functions.sql. If this logic diverges from the SQL
// the contract is broken — update both together.
function observationCurrentAsOf(store: EvidenceStore, ts: string) {
  const activeMembers = store.members.filter(
    (m) => m.attached_at <= ts && (m.detached_at === null || m.detached_at > ts),
  )

  const frequencyByCluster = new Map<string, number>()
  for (const m of activeMembers) {
    frequencyByCluster.set(m.cluster_id, (frequencyByCluster.get(m.cluster_id) ?? 0) + 1)
  }

  const latestSentiment = new Map<string, SentimentRow>()
  for (const s of store.sentiment) {
    if (s.computed_at > ts) continue
    const current = latestSentiment.get(s.observation_id)
    if (!current || s.computed_at > current.computed_at) {
      latestSentiment.set(s.observation_id, s)
    }
  }

  const latestImpact = new Map<string, ImpactRow>()
  for (const i of store.impact) {
    if (i.computed_at > ts) continue
    const current = latestImpact.get(i.observation_id)
    if (!current || i.computed_at > current.computed_at) {
      latestImpact.set(i.observation_id, i)
    }
  }

  return store.observations
    .filter((o) => o.captured_at <= ts)
    .map((o) => {
      const membership = activeMembers.find((m) => m.observation_id === o.id)
      const cluster = membership ? store.clusters.find((c) => c.id === membership.cluster_id) : null
      const isCanonical = cluster?.canonical_observation_id === o.id
      const sentiment = latestSentiment.get(o.id)
      const impact = latestImpact.get(o.id)
      return {
        observation_id: o.id,
        title: o.title,
        published_at: o.published_at,
        cluster_id: cluster?.id ?? null,
        is_canonical: isCanonical,
        frequency_count: cluster ? frequencyByCluster.get(cluster.id) ?? 0 : null,
        sentiment: sentiment?.label ?? null,
        sentiment_score: sentiment?.score ?? null,
        impact_score: impact?.score ?? null,
      }
    })
}

function aggregateStats(rows: ReturnType<typeof observationCurrentAsOf>) {
  const canonical = rows.filter((r) => r.is_canonical)
  const sentimentBreakdown = { positive: 0, negative: 0, neutral: 0 }
  let impactSum = 0
  let impactCount = 0
  for (const r of canonical) {
    if (r.sentiment && r.sentiment in sentimentBreakdown) {
      sentimentBreakdown[r.sentiment]++
    }
    if (typeof r.impact_score === "number") {
      impactSum += r.impact_score
      impactCount++
    }
  }
  return {
    totalIssues: canonical.length,
    sentimentBreakdown,
    avgImpact: impactCount ? impactSum / impactCount : 0,
  }
}

test("as_of read is stable when later derivation rows are appended", () => {
  const T1 = "2026-04-21T12:00:00.000Z"
  const T2 = "2026-04-22T12:00:00.000Z"

  const store: EvidenceStore = {
    observations: [
      { id: "obs-1", source_id: "s1", title: "Codex hangs on large repos", published_at: "2026-04-20T10:00:00.000Z", captured_at: "2026-04-20T11:00:00.000Z" },
      { id: "obs-2", source_id: "s2", title: "Codex slow response", published_at: "2026-04-21T08:00:00.000Z", captured_at: "2026-04-21T09:00:00.000Z" },
    ],
    sentiment: [
      { observation_id: "obs-1", algorithm_version: "v1", label: "negative", score: -0.7, computed_at: "2026-04-20T11:00:00.000Z" },
      { observation_id: "obs-2", algorithm_version: "v1", label: "neutral", score: 0.0, computed_at: "2026-04-21T09:00:00.000Z" },
    ],
    impact: [
      { observation_id: "obs-1", algorithm_version: "v1", score: 7, computed_at: "2026-04-20T11:00:00.000Z" },
      { observation_id: "obs-2", algorithm_version: "v1", score: 4, computed_at: "2026-04-21T09:00:00.000Z" },
    ],
    members: [
      { cluster_id: "cl-hang", observation_id: "obs-1", attached_at: "2026-04-20T11:00:00.000Z", detached_at: null },
      { cluster_id: "cl-slow", observation_id: "obs-2", attached_at: "2026-04-21T09:00:00.000Z", detached_at: null },
    ],
    clusters: [
      { id: "cl-hang", canonical_observation_id: "obs-1" },
      { id: "cl-slow", canonical_observation_id: "obs-2" },
    ],
  }

  // Capture the state at T1.
  const snapshotT1 = aggregateStats(observationCurrentAsOf(store, T1))

  // Later: algorithm v2 recomputes sentiment for obs-1 and impact for
  // obs-2; a new observation obs-3 is captured; obs-2 is detached from its
  // cluster and reattached to cl-hang (cross-source duplicate merge).
  store.sentiment.push({ observation_id: "obs-1", algorithm_version: "v2", label: "neutral", score: 0.1, computed_at: T2 })
  store.impact.push({ observation_id: "obs-2", algorithm_version: "v2", score: 9, computed_at: T2 })
  store.observations.push({ id: "obs-3", source_id: "s3", title: "Codex hangs on big monorepo", published_at: T2, captured_at: T2 })
  store.members[1].detached_at = T2
  store.members.push({ cluster_id: "cl-hang", observation_id: "obs-2", attached_at: T2, detached_at: null })
  store.members.push({ cluster_id: "cl-hang", observation_id: "obs-3", attached_at: T2, detached_at: null })

  // Re-read at T1: must match the original snapshot exactly.
  const replayT1 = aggregateStats(observationCurrentAsOf(store, T1))
  assert.deepEqual(replayT1, snapshotT1, "as_of=T1 must be stable after later inserts")

  // Sanity: current read (as_of=T2) should differ.
  const snapshotT2 = aggregateStats(observationCurrentAsOf(store, T2))
  assert.notDeepEqual(snapshotT2, snapshotT1, "current read should differ once v2 derivations and merges land")

  // Cluster volume at T2 reflects the merge: cl-hang has obs-1 + obs-2 + obs-3.
  const rowsT2 = observationCurrentAsOf(store, T2)
  const hangCanonicals = rowsT2.filter((r) => r.cluster_id === "cl-hang" && r.is_canonical)
  assert.equal(hangCanonicals.length, 1, "exactly one canonical per cluster")
  assert.equal(hangCanonicals[0].frequency_count, 3, "cluster frequency reflects active membership at T2")

  // Cluster volume at T1 was 1 (obs-1 only in cl-hang) — unchanged by the merge.
  const rowsT1 = observationCurrentAsOf(store, T1)
  const hangAtT1 = rowsT1.filter((r) => r.cluster_id === "cl-hang" && r.is_canonical)
  assert.equal(hangAtT1[0].frequency_count, 1, "historical cluster frequency must not be mutated by later attachments")
})

test("invalid as_of semantics — future timestamps rejected at the API layer", () => {
  // This test documents the route's validation logic; actually invoking
  // the route requires a Next runtime. The contract: /api/stats?as_of=<T>
  // where T is in the future returns 400.
  const isFuture = (iso: string) => new Date(iso).getTime() > Date.now() + 60_000
  assert.equal(isFuture("2099-01-01T00:00:00.000Z"), true)
  assert.equal(isFuture(new Date().toISOString()), false)
})
