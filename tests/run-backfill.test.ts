import test from "node:test"
import assert from "node:assert/strict"

import {
  BACKFILL_SELECT_CLAUSE,
  BACKFILL_SELECT_COLS,
  MIN_IMPACT_SCORE,
} from "../lib/classification/run-backfill-constants.ts"
import type { BackfillSourceRow } from "../lib/classification/backfill-candidates.ts"

// Pins the mv_observation_current SELECT that feeds both
// /api/cron/classify-backfill and /api/admin/classify-backfill against
// drift. The orchestrator in lib/classification/run-backfill.ts does
// I/O against Supabase + OpenAI so it isn't fixture-testable here;
// these invariants are the strongest thing we can check without a live
// DB. The I/O-heavy happy-path is validated end-to-end via the admin
// panel (see docs/BUGS.md N-10 verification checklist).

test("MIN_IMPACT_SCORE matches the documented threshold (ARCHITECTURE §3.5)", () => {
  // Hardcoded here so a silent edit that flips this threshold fails a
  // test rather than only the dashboard count. The docs and this
  // constant must move together.
  assert.equal(MIN_IMPACT_SCORE, 6)
})

test("BACKFILL_SELECT_CLAUSE is the joined column list", () => {
  assert.equal(BACKFILL_SELECT_CLAUSE, BACKFILL_SELECT_COLS.join(", "))
})

test("BACKFILL_SELECT_COLS includes every column buildBackfillCandidates reads", () => {
  // BackfillSourceRow is the compile-time contract. Any field it
  // references must ship in the SELECT or PostgREST will silently
  // omit it and the projection will read undefined. These keys mirror
  // the interface; update both together when the prompt payload
  // gains new fingerprint fields.
  const requiredByProjection: Array<keyof BackfillSourceRow> = [
    "observation_id",
    "title",
    "content",
    "url",
    "source_id",
    "cli_version",
    "fp_os",
    "fp_shell",
    "fp_editor",
    "model_id",
    "repro_markers",
  ]
  for (const col of requiredByProjection) {
    assert.ok(
      BACKFILL_SELECT_COLS.includes(col),
      `BACKFILL_SELECT_COLS is missing ${col} required by buildBackfillCandidates`,
    )
  }
})

test("BACKFILL_SELECT_COLS includes the filter + sort columns the orchestrator uses", () => {
  // The orchestrator filters on llm_classified_at IS NULL and sorts
  // by impact_score DESC, published_at DESC. PostgREST requires these
  // be in the SELECT for the ORDER BY to apply.
  for (const col of ["llm_classified_at", "impact_score", "published_at"]) {
    assert.ok(
      (BACKFILL_SELECT_COLS as readonly string[]).includes(col),
      `BACKFILL_SELECT_COLS missing filter/sort column ${col}`,
    )
  }
})

test("BACKFILL_SELECT_COLS has no duplicates", () => {
  const seen = new Set<string>()
  for (const col of BACKFILL_SELECT_COLS) {
    assert.ok(!seen.has(col), `duplicate column: ${col}`)
    seen.add(col)
  }
})
