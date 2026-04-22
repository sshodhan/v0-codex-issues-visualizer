import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const sql = readFileSync(join(process.cwd(), "scripts/011_phase_a_compat_and_refresh_hardening.sql"), "utf8").toLowerCase()

test("phase-a migration restores legacy compatibility surfaces", () => {
  assert.match(sql, /create or replace view issues\b/, "issues compatibility view missing")
  assert.match(sql, /create or replace function upsert_issue_observation\(payload jsonb\)/, "upsert_issue_observation compatibility rpc missing")
  assert.match(sql, /grant execute on function upsert_issue_observation\(jsonb\) to service_role/, "service_role execute grant missing")
})

test("refresh function reports per-view status with budget-aware degraded mode", () => {
  assert.match(sql, /create or replace function refresh_materialized_views\(max_budget_ms int default 15000\)/)
  assert.match(sql, /'skipped_budget'/, "budget skip status missing")
  assert.match(sql, /'duration_ms'/, "duration field missing")
  assert.match(sql, /'views'/, "views diagnostics field missing")
})

test("refresh function uses CONCURRENTLY for every MV and drops the old void-returning variant", () => {
  assert.match(sql, /drop function if exists refresh_materialized_views\(\)/, "must drop the pre-011 void-returning zero-arg function before replacing its return type")
  assert.match(sql, /refresh materialized view concurrently mv_observation_current/, "mv_observation_current must refresh concurrently")
  assert.match(sql, /refresh materialized view concurrently mv_trend_daily/, "mv_trend_daily must refresh concurrently (requires unique index)")
  assert.match(sql, /create unique index if not exists idx_mv_trend_daily_unique/, "unique index on mv_trend_daily required for CONCURRENTLY")
})

test("migration does not execute against the dropped mv_dashboard_stats", () => {
  // Dropped in the DB-analyst holistic review (commit 7b3ee74, item G6): the MV
  // was built every cron but never read. Any executable reference here would
  // fail on apply. We strip SQL line comments first so the header rationale
  // that names the MV doesn't false-positive this check.
  const uncommented = sql
    .split("\n")
    .map((line: string) => line.replace(/--.*$/, ""))
    .join("\n")
  assert.doesNotMatch(uncommented, /\bmv_dashboard_stats\b/, "mv_dashboard_stats was removed from 007 and must not be re-referenced in executable SQL")
})
