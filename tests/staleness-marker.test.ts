import test from "node:test"
import assert from "node:assert/strict"

import { emitEmbeddingStaleMarkerIfNeeded } from "../lib/storage/embedding-staleness-marker.ts"

// ============================================================================
// Phase 4 staleness marker tests.
//
// emitEmbeddingStaleMarkerIfNeeded is the helper called from
// recordClassification + recordClassificationReview in derivations.ts.
// It must:
//   1. No v3 row exists → no marker emitted (cold-start case).
//   2. v3 row exists → marker emitted with correct shape.
//   3. trigger_id propagated into detail_json.trigger_id.
//   4. algorithm_version_model is null (per fix #1 — non-model
//      strings shouldn't sit in the model slot).
//   5. Best-effort: lookup error doesn't throw.
//
// The mock supabase records every `from(...)` call so we can assert
// which tables were read/written and with what payload.
// ============================================================================

interface MockCall {
  table: string
  op: "select" | "insert"
  payload?: unknown
  filters?: Record<string, unknown>
}

function makeMockSupabase(opts: {
  selectResponses?: Record<
    string,
    { data: unknown; error: { message: string } | null }
  >
  insertResponses?: Record<string, { error: { message: string } | null }>
}) {
  const calls: MockCall[] = []
  const selectResponses = opts.selectResponses ?? {}
  const insertResponses = opts.insertResponses ?? {}

  function makeBuilder(table: string): any {
    const filters: Record<string, unknown> = {}
    const builder: any = {
      select: () => builder,
      insert: (payload: unknown) => {
        calls.push({ table, op: "insert", payload, filters })
        return Promise.resolve(insertResponses[table] ?? { error: null })
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val
        return builder
      },
      maybeSingle: () => {
        calls.push({ table, op: "select", filters })
        return Promise.resolve(
          selectResponses[table] ?? { data: null, error: null },
        )
      },
    }
    return builder
  }

  return {
    calls,
    client: {
      from(table: string) {
        return makeBuilder(table)
      },
    } as any,
  }
}

test("emits stale marker when v3 embedding exists for the obs", async () => {
  const mock = makeMockSupabase({
    selectResponses: {
      observation_embeddings: {
        data: { id: "embedding-row-1" },
        error: null,
      },
    },
  })

  await emitEmbeddingStaleMarkerIfNeeded(
    mock.client,
    "obs-1",
    "classification_updated",
    "cls-123",
  )

  // Lookup was made on observation_embeddings.
  const lookup = mock.calls.find(
    (c) => c.table === "observation_embeddings" && c.op === "select",
  )
  assert.ok(lookup, "expected observation_embeddings lookup")
  assert.equal(lookup!.filters?.observation_id, "obs-1")

  // Marker was inserted into processing_events.
  const insert = mock.calls.find(
    (c) => c.table === "processing_events" && c.op === "insert",
  )
  assert.ok(insert, "expected processing_events insert")
  const payload = insert!.payload as Record<string, unknown>
  assert.equal(payload.observation_id, "obs-1")
  assert.equal(payload.stage, "embedding")
  assert.equal(payload.status, "stale")
  // algorithm_version_model is null per fix #1.
  assert.equal(payload.algorithm_version_model, null)
  // detail_json carries trigger_id (fix #2) + reason + version.
  const detail = payload.detail_json as Record<string, unknown>
  assert.equal(detail.reason, "classification_updated")
  assert.equal(detail.trigger_id, "cls-123")
  assert.equal(typeof detail.embedding_algorithm_version, "string")
  assert.equal(typeof detail.marked_at, "string")
})

test("NO marker emitted when no v3 embedding exists", async () => {
  const mock = makeMockSupabase({
    selectResponses: {
      observation_embeddings: { data: null, error: null }, // cold-start
    },
  })

  await emitEmbeddingStaleMarkerIfNeeded(
    mock.client,
    "obs-2",
    "classification_updated",
    "cls-456",
  )

  // No insert call.
  const insert = mock.calls.find((c) => c.table === "processing_events")
  assert.equal(
    insert,
    undefined,
    "expected NO marker when no v3 embedding exists (cold start)",
  )
})

test("lookup error doesn't throw, doesn't insert marker", async () => {
  const mock = makeMockSupabase({
    selectResponses: {
      observation_embeddings: {
        data: null,
        error: { message: "lookup failed" },
      },
    },
  })

  // Should NOT throw.
  await emitEmbeddingStaleMarkerIfNeeded(
    mock.client,
    "obs-3",
    "classification_updated",
    "cls-789",
  )

  // No insert (best-effort: lookup errored, skipped emission).
  const insert = mock.calls.find((c) => c.table === "processing_events")
  assert.equal(insert, undefined)
})

test("review_updated reason + null trigger_id is handled", async () => {
  const mock = makeMockSupabase({
    selectResponses: {
      observation_embeddings: {
        data: { id: "embedding-row-1" },
        error: null,
      },
    },
  })

  await emitEmbeddingStaleMarkerIfNeeded(
    mock.client,
    "obs-4",
    "review_updated",
    null, // trigger_id can be null
  )

  const insert = mock.calls.find(
    (c) => c.table === "processing_events" && c.op === "insert",
  )
  assert.ok(insert, "expected processing_events insert")
  const detail = (insert!.payload as Record<string, unknown>).detail_json as Record<
    string,
    unknown
  >
  assert.equal(detail.reason, "review_updated")
  assert.equal(detail.trigger_id, null)
})

test("empty observationId is a no-op (defensive guard)", async () => {
  const mock = makeMockSupabase({})
  await emitEmbeddingStaleMarkerIfNeeded(
    mock.client,
    "",
    "classification_updated",
    "cls-1",
  )
  // No supabase calls at all — guard returns early.
  assert.equal(mock.calls.length, 0)
})

test("insert error logs but doesn't throw", async () => {
  const mock = makeMockSupabase({
    selectResponses: {
      observation_embeddings: {
        data: { id: "embedding-row-1" },
        error: null,
      },
    },
    insertResponses: {
      processing_events: { error: { message: "insert failed" } },
    },
  })

  // Should NOT throw — best-effort.
  await emitEmbeddingStaleMarkerIfNeeded(
    mock.client,
    "obs-5",
    "classification_updated",
    "cls-fail",
  )
})
