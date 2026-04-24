# Three-Layer DB Refactor Prompt Evaluation (Current Repository State)

_Date reviewed: 2026-04-21 (UTC)_

This document evaluates the repository's current implementation against the supplied prompt:

> **Implement Three-Layer DB Refactor with Safe Cutover, Replay Correctness, and Typed DB Contracts**

## Executive Summary

Current codebase status is **partially compliant**.

- The three-layer architecture is largely implemented in code and SQL.
- Typed RPCs and append-only behavior are mostly in place.
- `as_of` replay path exists and has targeted tests.
- **Critical gap:** migration strategy is not a safe two-phase cutover because migration `007_three_layer_split.sql` drops old tables/functions in the same migration that introduces new paths.
- **Operational gap:** materialized-view refresh is not fully hardened (limited observability/fallback behavior and non-concurrent refresh coverage).

## Requirement-by-Requirement Evaluation

### 1) Safe two-phase cutover (no big-bang drop)

**Status: ❌ Not met**

Evidence:

- `scripts/007_three_layer_split.sql` immediately drops old objects (`issues`, `bug_report_classifications`, `upsert_issue_observation`, etc.) at the top of the migration.
- The same migration then creates the new three-layer objects.

Implication:

- This is a **big-bang** migration, not a phased A/B cutover with coexistence.
- Rollback and live verification windows are reduced because old read/write paths are removed immediately.

### 2) Enforce append-only evidence contract

**Status: ✅ Mostly met**

Evidence:

- App write boundaries split into:
  - `lib/storage/evidence.ts` (evidence)
  - `lib/storage/derivations.ts` (derivations)
  - `lib/storage/clusters.ts` (aggregation)
- Evidence writes use RPCs only in storage module.
- `scripts/008_revoke_service_role_dml.sql` revokes direct DML (`INSERT/UPDATE/DELETE`) from `service_role` on evidence and derivation tables.
- `tests/evidence-append-only.test.ts` enforces no evidence `update/delete` usage in app/lib code and verifies migration 008 contains revokes.

Residual risk:

- This is strong at application + privilege layer, but still depends on teams honoring the storage-module boundary for future code changes.

### 3) Replace generic derivation write RPC with typed RPCs

**Status: ✅ Met**

Evidence:

- Typed SQL RPCs exist in migration and are used from `lib/storage/derivations.ts`:
  - `record_sentiment`
  - `record_category`
  - `record_impact`
  - `record_competitor_mention`
  - `record_classification`
  - `record_classification_review`
- No generic `record_derivation(table_name, ...)` surface is used.

### 4) Correct `as_of` replay semantics

**Status: ✅ Met (for current scope)**

Evidence:

- `scripts/009_as_of_functions.sql` introduces `observation_current_as_of(ts)` with time-bounded selection (`computed_at <= ts`, membership interval checks, captured-time constraints).
- `/api/stats` uses the temporal RPC when `?as_of=` is provided.
- `tests/replay.test.ts` validates T1 stability after T2 inserts and cluster membership changes.

Caveat:

- Replay correctness is implemented for stats flows; verify whether any additional API surfaces should also support `as_of` in future requirements.

### 5) MV refresh hardening

**Status: ⚠️ Partially met**

Evidence:

- Scraper pipeline runs refresh at the end via `refresh_materialized_views` RPC (`lib/scrapers/index.ts`).
- SQL refresh function exists in migration 007.

Gaps vs prompt:

- Only `mv_observation_current` is refreshed `CONCURRENTLY`; other MVs are not.
- No explicit per-MV duration logging in SQL or route response.
- No refresh budget/timeout/degraded-mode behavior surfaced to caller.
- No explicit error bucketing per MV (single RPC error currently logged).

### 6) Keep migration history immutable

**Status: ✅ Met**

Evidence:

- Historical migration files remain present (`001`..`006`).
- New forward-only migrations were added (`007`, `008`, `009`) instead of rewriting/deleting old files.

## Route-by-Route Behavior Check

- `/api/issues`: reads from `mv_observation_current` with compatibility aliasing for sort fields.
- `/api/stats`: reads from current MV by default; switches to `observation_current_as_of(ts)` for temporal replay.
- `/api/classify`: appends immutable classification rows through typed derivation storage API.
- `/api/classifications/[id]` `PATCH`: appends review rows (`classification_reviews`) instead of mutating baseline.
- `/api/classifications` and `/api/classifications/stats`: compute effective state as baseline + latest review.
- `/api/cron/scrape`: runs scraping and refreshes materialized views at end through scraper pipeline.

## What to Change to Fully Satisfy the Prompt

### Phase A (safe cutover)

1. Add a **new migration** (e.g., `010_phase_a_compat.sql`) that restores compatibility objects needed for dual-path read/write during rollout if cutover has not happened in production yet.
2. Maintain old read/write surfaces (or compatibility views/functions) until production verification completes.
3. Add explicit deployment runbook steps for dual-read checks and repull verification windows.

### Phase B (cleanup)

1. Add a later migration (e.g., `011_phase_b_cleanup.sql`) that removes old compatibility objects only after monitoring sign-off.
2. Keep rollback guidance documented (object recreation strategy + data replay scope).

### MV hardening enhancements

1. Implement per-MV refresh timings and structured result payload.
2. Use `CONCURRENTLY` where valid and ensure required unique indexes exist for each concurrently refreshed MV.
3. Add a refresh budget with graceful degradation (e.g., skip heavy MV on timeout and return warning status).
4. Surface refresh diagnostics in cron response and logs.

## Suggested “Single-PR, Three-Commit” Breakdown

1. **Commit 1 – Phase A compatibility + runbook:**
   - Introduce compatibility migration and docs for dual-read/write verification.
2. **Commit 2 – MV hardening:**
   - Enhance refresh function return shape, timing, concurrent strategy, degraded mode handling.
3. **Commit 3 – Phase B cleanup:**
   - Remove compatibility layer objects and finalize architecture docs once verification is complete.

## Risk Notes

- The largest production risk remains migration `007` being destructive at introduction time.
- If already deployed, safest remediation is introducing compatibility shims immediately and documenting exact replay/repull procedure.
- Refresh-path observability is currently too coarse for incident debugging under load.
