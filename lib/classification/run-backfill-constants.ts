// Dep-free constants for the classify-backfill orchestrator, extracted
// so `tests/run-backfill.test.ts` can pin them without resolving the
// `@/*` alias graph that `run-backfill.ts` pulls in (supabase, zod,
// classification pipeline, etc.). node:test --experimental-strip-types
// cannot walk through `@/*`; every module reachable from a test must
// use relative .ts imports. See the Testability invariant in
// docs/ARCHITECTURE.md §4.1.

// Canonical only. Cluster-level surfaces (Priority Matrix bubbles, AI
// tab triage) read off the canonical row; classifying non-canonical
// members burns ~$0.04 each without changing what the dashboard shows.
export const MIN_IMPACT_SCORE = 6

// Kept in lock-step with `BackfillSourceRow` in
// lib/classification/backfill-candidates.ts — any field that projection
// reads MUST appear here so the mv_observation_current SELECT returns
// it. The orchestrator also selects `llm_classified_at` (filter column)
// and `impact_score` / `published_at` (order-by columns) which
// BackfillSourceRow doesn't type because they aren't threaded into the
// prompt.
export const BACKFILL_SELECT_COLS = [
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
  "llm_classified_at",
  "impact_score",
  "published_at",
] as const

export const BACKFILL_SELECT_CLAUSE = BACKFILL_SELECT_COLS.join(", ")
