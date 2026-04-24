import test from "node:test"
import assert from "node:assert/strict"
import {
  buildCronRun,
  cronForRow,
  deriveDurationMs,
  matchesFilters,
  normalizeStatus,
  sortCronRunsDesc,
  type CronRun,
  type ScrapeLogRow,
  type SourceLookupRow,
} from "../lib/cron-runs/shape.ts"

function srcMap(sources: SourceLookupRow[]): Map<string, SourceLookupRow> {
  const m = new Map<string, SourceLookupRow>()
  for (const s of sources) m.set(s.id, s)
  return m
}

function row(partial: Partial<ScrapeLogRow>): ScrapeLogRow {
  return {
    id: partial.id ?? "row-1",
    source_id: partial.source_id ?? null,
    status: partial.status ?? "completed",
    issues_found: partial.issues_found ?? 0,
    issues_added: partial.issues_added ?? 0,
    error_message: partial.error_message ?? null,
    started_at: partial.started_at ?? "2026-01-01T00:00:00.000Z",
    completed_at: partial.completed_at ?? null,
  }
}

test("cronForRow maps null source_id to classify-backfill and non-null to scrape", () => {
  assert.equal(cronForRow(row({ source_id: null })), "classify-backfill")
  assert.equal(cronForRow(row({ source_id: "src-1" })), "scrape")
})

test("normalizeStatus clamps unknown text to 'failed' so anomalies surface", () => {
  assert.equal(normalizeStatus("completed"), "completed")
  assert.equal(normalizeStatus("running"), "running")
  assert.equal(normalizeStatus("banana"), "failed")
})

test("deriveDurationMs returns null for running rows and ms for completed rows", () => {
  assert.equal(
    deriveDurationMs("2026-01-01T00:00:00.000Z", null),
    null,
    "null completed_at ⇒ null duration",
  )
  assert.equal(
    deriveDurationMs("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:02.500Z"),
    2500,
  )
  assert.equal(
    deriveDurationMs("2026-01-01T00:00:05.000Z", "2026-01-01T00:00:00.000Z"),
    0,
    "negative skew clamps to 0",
  )
})

test("buildCronRun attaches source metadata for scrape rows and null for backfill rows", () => {
  const sources = srcMap([
    { id: "src-1", slug: "github", name: "GitHub" },
    { id: "src-2", slug: "stackoverflow", name: "Stack Overflow" },
  ])

  const scrapeRun = buildCronRun(
    row({
      id: "r1",
      source_id: "src-1",
      status: "completed",
      issues_found: 12,
      issues_added: 3,
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:01.000Z",
    }),
    sources,
  )
  assert.equal(scrapeRun.cron, "scrape")
  assert.deepEqual(scrapeRun.source, {
    id: "src-1",
    slug: "github",
    name: "GitHub",
  })
  assert.equal(scrapeRun.duration_ms, 1000)
  assert.equal(scrapeRun.issues_found, 12)
  assert.equal(scrapeRun.issues_added, 3)

  const backfillRun = buildCronRun(row({ id: "r2", source_id: null }), sources)
  assert.equal(backfillRun.cron, "classify-backfill")
  assert.equal(backfillRun.source, null)
})

test("buildCronRun coalesces null counts to 0 so the UI never shows NaN", () => {
  const run = buildCronRun(
    row({ issues_found: null as unknown as number, issues_added: null as unknown as number }),
    srcMap([]),
  )
  assert.equal(run.issues_found, 0)
  assert.equal(run.issues_added, 0)
})

test("matchesFilters filters by cron, sourceSlug, and status independently", () => {
  const base: CronRun = {
    id: "r1",
    cron: "scrape",
    source: { id: "src-1", slug: "github", name: "GitHub" },
    status: "completed",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1000,
    issues_found: 1,
    issues_added: 1,
    error_message: null,
  }

  assert.equal(matchesFilters(base, {}), true)
  assert.equal(matchesFilters(base, { cron: "scrape" }), true)
  assert.equal(matchesFilters(base, { cron: "classify-backfill" }), false)
  assert.equal(matchesFilters(base, { sourceSlug: "github" }), true)
  assert.equal(matchesFilters(base, { sourceSlug: "stackoverflow" }), false)
  assert.equal(matchesFilters(base, { status: "completed" }), true)
  assert.equal(matchesFilters(base, { status: "failed" }), false)

  const backfill: CronRun = { ...base, cron: "classify-backfill", source: null }
  // Backfill rows have no source, so any explicit source filter excludes them.
  assert.equal(matchesFilters(backfill, { sourceSlug: "github" }), false)
})

test("sortCronRunsDesc orders by started_at desc with id as a tiebreaker", () => {
  const runs: CronRun[] = [
    {
      id: "a",
      cron: "scrape",
      source: null,
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
      duration_ms: null,
      issues_found: 0,
      issues_added: 0,
      error_message: null,
    },
    {
      id: "b",
      cron: "scrape",
      source: null,
      status: "completed",
      started_at: "2026-01-01T00:00:01.000Z",
      completed_at: null,
      duration_ms: null,
      issues_found: 0,
      issues_added: 0,
      error_message: null,
    },
    {
      id: "c",
      cron: "scrape",
      source: null,
      status: "completed",
      started_at: "2026-01-01T00:00:01.000Z",
      completed_at: null,
      duration_ms: null,
      issues_found: 0,
      issues_added: 0,
      error_message: null,
    },
  ]

  const sorted = sortCronRunsDesc(runs)
  // Newer first; same timestamp ⇒ higher id first.
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["c", "b", "a"],
  )
})
