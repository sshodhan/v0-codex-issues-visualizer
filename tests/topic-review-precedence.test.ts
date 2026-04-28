import { describe, it } from "node:test"
import * as assert from "node:assert"
import { buildManualOverrideEvidence } from "../lib/admin/topic-review.ts"

// Documents and locks the manual-override precedence contract per
// docs/SCORING.md §11.5. The contract is implemented by the existing
// `latest_category` CTE in `mv_observation_current` (scripts/018):
//
//   select distinct on (observation_id) ...
//   from category_assignments
//   order by observation_id, computed_at desc
//
// In other words, the most recent row by `computed_at` per observation
// wins on read. `record_manual_topic_override` inserts a row with a
// fresh `now()` timestamp, so a manual override wins immediately —
// until a future Stage-1 backfill writes a newer deterministic row, at
// which point the deterministic row supersedes the manual until the
// reviewer re-records the override.
//
// This test simulates the CTE in JS so a future change to the ordering
// rule (for example, giving manual rows explicit precedence regardless
// of timestamp) breaks here visibly.

interface Row {
  observation_id: string
  algorithm_version: string
  category_id: string
  computed_at: string // ISO timestamp
}

// Mirrors `select distinct on (observation_id) ... order by
// observation_id, computed_at desc` for a single observation. Returns
// the row that mv_observation_current.latest_category would surface.
function pickLatestCategory(rows: Row[], observationId: string): Row | null {
  const candidates = rows.filter((r) => r.observation_id === observationId)
  if (candidates.length === 0) return null
  return candidates.reduce((winner, row) =>
    new Date(row.computed_at).getTime() > new Date(winner.computed_at).getTime()
      ? row
      : winner,
  )
}

describe("manual override precedence (max(computed_at) contract)", () => {
  const obs = "obs-123"

  it("manual override wins immediately after it is recorded", () => {
    const rows: Row[] = [
      // Stage 1 v6 deterministic verdict from a recent ingest.
      {
        observation_id: obs,
        algorithm_version: "v6",
        category_id: "cat-bug",
        computed_at: "2026-04-28T08:00:00Z",
      },
      // Reviewer applies a manual override 3 hours later.
      {
        observation_id: obs,
        algorithm_version: "manual",
        category_id: "cat-feature-request",
        computed_at: "2026-04-28T11:00:00Z",
      },
    ]

    const winner = pickLatestCategory(rows, obs)
    assert.ok(winner)
    assert.strictEqual(winner.algorithm_version, "manual")
    assert.strictEqual(winner.category_id, "cat-feature-request")
  })

  it("a future Stage-1 backfill at v7 supersedes the manual override on read", () => {
    // Documents the path-B trade-off: the override row is preserved
    // but the dashboard picks the freshest deterministic row after a
    // full-corpus backfill. The reviewer has to re-record (see the
    // next test) to pin the override again.
    const rows: Row[] = [
      {
        observation_id: obs,
        algorithm_version: "v6",
        category_id: "cat-bug",
        computed_at: "2026-04-28T08:00:00Z",
      },
      {
        observation_id: obs,
        algorithm_version: "manual",
        category_id: "cat-feature-request",
        computed_at: "2026-04-28T11:00:00Z",
      },
      // Stage-1 v7 backfill runs after the override.
      {
        observation_id: obs,
        algorithm_version: "v7",
        category_id: "cat-bug",
        computed_at: "2026-05-15T03:00:00Z",
      },
    ]

    const winner = pickLatestCategory(rows, obs)
    assert.ok(winner)
    assert.strictEqual(winner.algorithm_version, "v7")
    assert.strictEqual(winner.category_id, "cat-bug")
  })

  it("re-recording the override after a backfill restores it", () => {
    const rows: Row[] = [
      {
        observation_id: obs,
        algorithm_version: "v6",
        category_id: "cat-bug",
        computed_at: "2026-04-28T08:00:00Z",
      },
      {
        observation_id: obs,
        algorithm_version: "manual",
        category_id: "cat-feature-request",
        computed_at: "2026-04-28T11:00:00Z",
      },
      {
        observation_id: obs,
        algorithm_version: "v7",
        category_id: "cat-bug",
        computed_at: "2026-05-15T03:00:00Z",
      },
      // Reviewer re-records the override after noticing the v7 flip.
      {
        observation_id: obs,
        algorithm_version: "manual",
        category_id: "cat-feature-request",
        computed_at: "2026-05-15T09:30:00Z",
      },
    ]

    const winner = pickLatestCategory(rows, obs)
    assert.ok(winner)
    assert.strictEqual(winner.algorithm_version, "manual")
    assert.strictEqual(winner.category_id, "cat-feature-request")
  })

  it("retracting an override appends a manual row pointing back at the deterministic slug", () => {
    // Documents the "never DELETE; append a retracting manual row"
    // pattern. The retracting row carries its own evidence so the
    // audit trail captures both the original override and the reason
    // for the reversal.
    const initialOverride = buildManualOverrideEvidence({
      overriddenAssignment: {
        algorithmVersion: "v6",
        categoryId: "cat-bug",
        slug: "bug",
        confidence: 0.85,
      },
      corrected: { categoryId: "cat-feature-request", slug: "feature-request" },
      reasonCode: "phrase_false_positive",
      suggestedLayer: "regex_topic",
      suggestedAction: "manual_override_only",
      rationale: "looks like a feature ask, not a bug",
      reviewer: "alice@example.com",
      reviewedAt: "2026-04-28T11:00:00Z",
    })

    const retraction = buildManualOverrideEvidence({
      // The retraction's "overridden" view is the previous manual
      // verdict, since that's what's currently effective.
      overriddenAssignment: {
        algorithmVersion: "manual",
        categoryId: "cat-feature-request",
        slug: "feature-request",
        confidence: 1.0,
      },
      corrected: { categoryId: "cat-bug", slug: "bug" },
      reasonCode: "other",
      suggestedLayer: "regex_topic",
      suggestedAction: "manual_override_only",
      rationale: "previous override was wrong; restoring deterministic verdict",
      reviewer: "alice@example.com",
      reviewedAt: "2026-04-29T10:00:00Z",
    })

    // Retraction points back at the original deterministic slug.
    assert.strictEqual(retraction.corrected.slug, "bug")
    assert.strictEqual(retraction.corrected.category_id, "cat-bug")
    // And captures what it's reversing (the previous manual verdict).
    assert.strictEqual(retraction.overridden_assignment.algorithm_version, "manual")
    assert.strictEqual(retraction.overridden_assignment.slug, "feature-request")
    // The original override is unchanged — the audit trail stays whole.
    assert.strictEqual(initialOverride.corrected.slug, "feature-request")
    assert.strictEqual(initialOverride.overridden_assignment.slug, "bug")
  })
})
