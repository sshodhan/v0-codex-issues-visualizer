import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const sql = readFileSync(join(process.cwd(), "scripts/010_phase_a_compat_and_refresh_hardening.sql"), "utf8").toLowerCase()

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
