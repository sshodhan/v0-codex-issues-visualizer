import assert from "node:assert/strict"
import { test } from "node:test"
import {
  bucketByDay,
  filterByCluster,
  filterByHeuristic,
  filterByLlm,
  formatPct,
  sentimentSplit,
  topByImpact,
  topErrorCodes,
  topSources,
} from "./story-drawer-data.ts"
import type { Issue } from "../../hooks/use-dashboard-data.ts"

const DAY_MS = 86_400_000

function mkIssue(overrides: Partial<Issue>): Issue {
  return {
    id: overrides.id ?? "id",
    title: overrides.title ?? "title",
    content: overrides.content ?? "",
    url: overrides.url ?? "https://example.com",
    author: overrides.author ?? "a",
    sentiment: overrides.sentiment ?? "neutral",
    sentiment_score: overrides.sentiment_score ?? 0,
    impact_score: overrides.impact_score ?? 1,
    frequency_count: overrides.frequency_count ?? 1,
    upvotes: overrides.upvotes ?? 0,
    comments_count: overrides.comments_count ?? 0,
    published_at: overrides.published_at ?? new Date().toISOString(),
    source: overrides.source ?? { name: "GH", slug: "github", icon: "g" },
    category: overrides.category ?? { name: "Bug", slug: "bug", color: "#ef4444" },
    error_code: overrides.error_code ?? null,
    top_stack_frame: overrides.top_stack_frame ?? null,
    top_stack_frame_hash: overrides.top_stack_frame_hash ?? null,
    cli_version: overrides.cli_version ?? null,
    fp_os: overrides.fp_os ?? null,
    fp_shell: overrides.fp_shell ?? null,
    fp_editor: overrides.fp_editor ?? null,
    model_id: overrides.model_id ?? null,
    repro_markers: overrides.repro_markers ?? null,
    fp_keyword_presence: overrides.fp_keyword_presence ?? null,
    llm_subcategory: overrides.llm_subcategory ?? null,
    llm_primary_tag: overrides.llm_primary_tag ?? null,
    fingerprint_algorithm_version: overrides.fingerprint_algorithm_version ?? null,
    cluster_key_compound: overrides.cluster_key_compound ?? null,
    cluster_id: overrides.cluster_id ?? null,
    cluster_key: overrides.cluster_key ?? null,
  } as Issue
}

test("bucketByDay produces one entry per day in the range, including zero-count days", () => {
  const start = new Date("2026-04-20T00:00:00Z").getTime()
  const end = new Date("2026-04-22T00:00:00Z").getTime()
  const issues = [
    mkIssue({ id: "a", published_at: "2026-04-20T05:00:00Z" }),
    mkIssue({ id: "b", published_at: "2026-04-20T18:00:00Z" }),
    // 2026-04-21 has zero
    mkIssue({ id: "c", published_at: "2026-04-22T03:00:00Z" }),
  ]
  const out = bucketByDay(issues, start, end)
  assert.equal(out.length, 3)
  // Day 0 has 2 (depends on local TZ but should be either 0 or 2; test with UTC stable assumption)
  const total = out.reduce((s, p) => s + p.count, 0)
  assert.equal(total, 3)
  // Has at least one zero-count bucket
  assert.ok(out.some((p) => p.count === 0))
})

test("bucketByDay handles single-day window", () => {
  const start = new Date("2026-04-20T00:00:00Z").getTime()
  const end = new Date("2026-04-20T20:00:00Z").getTime()
  const out = bucketByDay([mkIssue({ published_at: "2026-04-20T10:00:00Z" })], start, end)
  assert.equal(out.length, 1)
  assert.equal(out[0].count, 1)
})

test("bucketByDay ignores issues with missing or invalid dates", () => {
  const start = Date.now()
  const end = start + DAY_MS
  const issues = [
    mkIssue({ id: "ok", published_at: new Date(start + 100).toISOString() }),
    mkIssue({ id: "no-date", published_at: "" as unknown as string }),
    mkIssue({ id: "garbage", published_at: "not-a-date" }),
  ]
  const out = bucketByDay(issues, start, end)
  const total = out.reduce((s, p) => s + p.count, 0)
  assert.equal(total, 1)
})

test("sentimentSplit aggregates positive / neutral / negative", () => {
  const out = sentimentSplit([
    mkIssue({ sentiment: "positive" }),
    mkIssue({ sentiment: "negative" }),
    mkIssue({ sentiment: "negative" }),
    mkIssue({ sentiment: "neutral" }),
  ])
  assert.deepEqual(out, { positive: 1, neutral: 1, negative: 2, total: 4 })
})

test("topSources sorts by count desc and caps at limit", () => {
  const issues = [
    mkIssue({ source: { name: "GH", slug: "gh", icon: "g" } }),
    mkIssue({ source: { name: "GH", slug: "gh", icon: "g" } }),
    mkIssue({ source: { name: "GH", slug: "gh", icon: "g" } }),
    mkIssue({ source: { name: "X", slug: "x", icon: "x" } }),
    mkIssue({ source: { name: "Reddit", slug: "reddit", icon: "r" } }),
    mkIssue({ source: { name: "Reddit", slug: "reddit", icon: "r" } }),
  ]
  const out = topSources(issues, 2)
  assert.equal(out.length, 2)
  assert.equal(out[0].slug, "gh")
  assert.equal(out[0].count, 3)
  assert.equal(out[1].slug, "reddit")
})

test("topSources falls back to 'unknown' when source is null", () => {
  const issue = mkIssue({})
  // Force source: null after construction (mkIssue's `??` defaults swallow null)
  ;(issue as { source: Issue["source"] }).source = null
  const out = topSources([issue])
  assert.equal(out[0].slug, "unknown")
})

test("topErrorCodes excludes nulls and ranks by frequency", () => {
  const issues = [
    mkIssue({ error_code: "E_TIMEOUT" }),
    mkIssue({ error_code: "E_TIMEOUT" }),
    mkIssue({ error_code: "E_QUOTA" }),
    mkIssue({ error_code: null }),
    mkIssue({ error_code: "" }),
  ]
  const out = topErrorCodes(issues)
  assert.equal(out.length, 2)
  assert.equal(out[0].code, "E_TIMEOUT")
  assert.equal(out[0].count, 2)
})

test("topByImpact orders desc and respects limit", () => {
  const out = topByImpact(
    [
      mkIssue({ id: "low", impact_score: 1 }),
      mkIssue({ id: "high", impact_score: 9 }),
      mkIssue({ id: "mid", impact_score: 5 }),
    ],
    2,
  )
  assert.deepEqual(
    out.map((i) => i.id),
    ["high", "mid"],
  )
})

test("filterByHeuristic / filterByLlm / filterByCluster pick the right issues", () => {
  const issues = [
    mkIssue({
      id: "h",
      category: { name: "Bug", slug: "bug", color: "#000" },
      llm_primary_tag: "tool_invocation_error",
      cluster_id: "abc",
    }),
    mkIssue({
      id: "p",
      category: { name: "Performance", slug: "performance", color: "#000" },
      llm_primary_tag: "code_generation_bug",
      cluster_id: "xyz",
    }),
  ]
  assert.equal(filterByHeuristic(issues, "bug").length, 1)
  assert.equal(filterByLlm(issues, "TOOL_INVOCATION_ERROR").length, 1) // case-insensitive
  assert.equal(filterByCluster(issues, "xyz").length, 1)
})

test("formatPct returns null for invalid values, % for valid", () => {
  assert.equal(formatPct(0.5), "50%")
  assert.equal(formatPct(0), "0%")
  assert.equal(formatPct(null), null)
  assert.equal(formatPct(undefined), null)
  assert.equal(formatPct(Number.NaN), null)
})
