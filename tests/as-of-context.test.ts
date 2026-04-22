import test from "node:test"
import assert from "node:assert/strict"

// Tests for Commit 12: as_of Threaded Through UI + APIs
//
// The as_of parameter enables point-in-time replay of the dashboard state.
// These tests validate the URL parameter parsing, context propagation, and
// API filtering behavior.

// Simulates the as_of validation logic from app/page.tsx
function validateAsOf(asOfRaw: string | null): string | null {
  if (!asOfRaw) return null
  const parsed = new Date(asOfRaw)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  if (parsed.getTime() > Date.now() + 60_000) {
    return null
  }
  return asOfRaw
}

// Simulates URL building logic from hooks/use-dashboard-data.ts
function buildStatsUrl(options?: {
  days?: number
  category?: string
  asOf?: string
}): string {
  const params = new URLSearchParams()
  if (options?.days) params.set("days", String(options.days))
  if (options?.category && options.category !== "all") params.set("category", options.category)
  if (options?.asOf) params.set("as_of", options.asOf)
  const queryString = params.toString()
  return queryString ? `/api/stats?${queryString}` : "/api/stats"
}

function buildIssuesUrl(filters?: {
  source?: string
  category?: string
  days?: number
  asOf?: string
}): string {
  const params = new URLSearchParams()
  if (filters?.source) params.set("source", filters.source)
  if (filters?.category) params.set("category", filters.category)
  if (filters?.days) params.set("days", filters.days.toString())
  if (filters?.asOf) params.set("as_of", filters.asOf)
  return `/api/issues?${params.toString()}`
}

function buildClassificationsUrl(filters?: {
  status?: string
  category?: string
  limit?: number
  asOf?: string
}): string {
  const params = new URLSearchParams()
  if (filters?.status) params.set("status", filters.status)
  if (filters?.category) params.set("category", filters.category)
  if (filters?.limit) params.set("limit", String(filters.limit))
  if (filters?.asOf) params.set("as_of", filters.asOf)
  return `/api/classifications?${params.toString()}`
}

test("validateAsOf accepts valid ISO8601 timestamps", () => {
  const validTimestamps = [
    "2026-04-21T12:00:00.000Z",
    "2026-03-01T00:00:00Z",
    "2025-12-31T23:59:59.999Z",
  ]

  for (const ts of validTimestamps) {
    const result = validateAsOf(ts)
    assert.equal(result, ts, `Valid timestamp ${ts} should be accepted`)
  }
})

test("validateAsOf rejects invalid timestamps", () => {
  const invalidTimestamps = [
    "not-a-date",
    "2026-13-01T00:00:00Z", // Invalid month
    "garbage",
    "",
  ]

  for (const ts of invalidTimestamps) {
    const result = validateAsOf(ts)
    assert.equal(result, null, `Invalid timestamp "${ts}" should be rejected`)
  }
})

test("validateAsOf rejects future timestamps", () => {
  const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const result = validateAsOf(futureDate)
  assert.equal(result, null, "Future timestamps should be rejected")
})

test("validateAsOf returns null for null input", () => {
  const result = validateAsOf(null)
  assert.equal(result, null)
})

test("buildStatsUrl includes as_of parameter when provided", () => {
  const url = buildStatsUrl({ asOf: "2026-04-21T12:00:00.000Z" })
  assert.ok(url.includes("as_of="), "URL should contain as_of parameter")
  assert.ok(url.includes("2026-04-21"), "URL should contain the timestamp")
})

test("buildStatsUrl includes all global filter params", () => {
  const url = buildStatsUrl({
    days: 7,
    category: "bug",
    asOf: "2026-04-21T12:00:00.000Z",
  })
  assert.ok(url.includes("days=7"), "URL should contain days parameter")
  assert.ok(url.includes("category=bug"), "URL should contain category parameter")
  assert.ok(url.includes("as_of="), "URL should contain as_of parameter")
})

test("buildStatsUrl excludes 'all' category", () => {
  const url = buildStatsUrl({ category: "all" })
  assert.ok(!url.includes("category="), "URL should not contain category=all")
})

test("buildStatsUrl returns base URL when no options", () => {
  const url = buildStatsUrl()
  assert.equal(url, "/api/stats")
})

test("buildIssuesUrl threads as_of through to API", () => {
  const url = buildIssuesUrl({
    source: "reddit",
    category: "bug",
    days: 30,
    asOf: "2026-03-01T00:00:00Z",
  })
  assert.ok(url.includes("source=reddit"))
  assert.ok(url.includes("category=bug"))
  assert.ok(url.includes("days=30"))
  assert.ok(url.includes("as_of=2026-03-01"))
})

test("buildClassificationsUrl threads as_of through to API", () => {
  const url = buildClassificationsUrl({
    status: "triaged",
    limit: 50,
    asOf: "2026-03-01T00:00:00Z",
  })
  assert.ok(url.includes("status=triaged"))
  assert.ok(url.includes("limit=50"))
  assert.ok(url.includes("as_of=2026-03-01"))
})

// Simulates the as_of filtering logic from app/api/classifications/route.ts
interface Classification {
  id: string
  created_at: string
}

interface Review {
  classification_id: string
  reviewed_at: string
}

function filterClassificationsByAsOf(
  classifications: Classification[],
  asOf: string | null,
): Classification[] {
  if (!asOf) return classifications
  const asOfDate = new Date(asOf)
  return classifications.filter((c) => new Date(c.created_at) <= asOfDate)
}

function filterReviewsByAsOf(reviews: Review[], asOf: string | null): Review[] {
  if (!asOf) return reviews
  const asOfDate = new Date(asOf)
  return reviews.filter((r) => new Date(r.reviewed_at) <= asOfDate)
}

test("classifications filter by created_at <= as_of", () => {
  const classifications: Classification[] = [
    { id: "cls-1", created_at: "2026-04-20T10:00:00.000Z" },
    { id: "cls-2", created_at: "2026-04-21T10:00:00.000Z" },
    { id: "cls-3", created_at: "2026-04-22T10:00:00.000Z" },
  ]

  const asOf = "2026-04-21T12:00:00.000Z"
  const filtered = filterClassificationsByAsOf(classifications, asOf)

  assert.equal(filtered.length, 2, "Should include classifications before as_of")
  assert.deepEqual(
    filtered.map((c) => c.id),
    ["cls-1", "cls-2"],
  )
})

test("reviews filter by reviewed_at <= as_of", () => {
  const reviews: Review[] = [
    { classification_id: "cls-1", reviewed_at: "2026-04-20T12:00:00.000Z" },
    { classification_id: "cls-1", reviewed_at: "2026-04-21T12:00:00.000Z" },
    { classification_id: "cls-1", reviewed_at: "2026-04-22T12:00:00.000Z" },
  ]

  const asOf = "2026-04-21T12:00:00.000Z"
  const filtered = filterReviewsByAsOf(reviews, asOf)

  assert.equal(filtered.length, 2, "Should include reviews before as_of")
})

test("as_of=null returns all records (live mode)", () => {
  const classifications: Classification[] = [
    { id: "cls-1", created_at: "2026-04-20T10:00:00.000Z" },
    { id: "cls-2", created_at: "2026-04-21T10:00:00.000Z" },
  ]

  const filtered = filterClassificationsByAsOf(classifications, null)
  assert.equal(filtered.length, 2, "Live mode returns all classifications")
})

// Simulates the global filter logic from app/api/stats/route.ts
interface ObservationRow {
  id: string
  category_id: string
  published_at: string
}

function applyGlobalFilters(
  rows: ObservationRow[],
  options: {
    filterDays: number | null
    filterCategoryId: string | null
    anchor: number // timestamp in ms
  },
): ObservationRow[] {
  const { filterDays, filterCategoryId, anchor } = options
  if (!filterDays && !filterCategoryId) return rows

  const cutoffTime = filterDays ? anchor - filterDays * 24 * 60 * 60 * 1000 : null

  return rows.filter((r) => {
    if (cutoffTime && r.published_at) {
      const pubTime = new Date(r.published_at).getTime()
      if (pubTime < cutoffTime) return false
    }
    if (filterCategoryId && r.category_id !== filterCategoryId) return false
    return true
  })
}

test("global filters apply days filter relative to as_of anchor", () => {
  const anchor = new Date("2026-04-21T12:00:00.000Z").getTime()

  const rows: ObservationRow[] = [
    { id: "obs-1", category_id: "cat-1", published_at: "2026-04-20T10:00:00.000Z" }, // 1 day ago
    { id: "obs-2", category_id: "cat-1", published_at: "2026-04-14T10:00:00.000Z" }, // 7 days ago
    { id: "obs-3", category_id: "cat-1", published_at: "2026-04-01T10:00:00.000Z" }, // 20 days ago
  ]

  const filtered = applyGlobalFilters(rows, {
    filterDays: 7,
    filterCategoryId: null,
    anchor,
  })

  assert.equal(filtered.length, 2, "7-day filter should include obs-1 and obs-2")
  assert.deepEqual(
    filtered.map((r) => r.id),
    ["obs-1", "obs-2"],
  )
})

test("global filters apply category filter", () => {
  const anchor = Date.now()

  const rows: ObservationRow[] = [
    { id: "obs-1", category_id: "cat-bug", published_at: "2026-04-20T10:00:00.000Z" },
    { id: "obs-2", category_id: "cat-feature", published_at: "2026-04-20T11:00:00.000Z" },
    { id: "obs-3", category_id: "cat-bug", published_at: "2026-04-20T12:00:00.000Z" },
  ]

  const filtered = applyGlobalFilters(rows, {
    filterDays: null,
    filterCategoryId: "cat-bug",
    anchor,
  })

  assert.equal(filtered.length, 2, "Category filter should include only bugs")
  assert.deepEqual(
    filtered.map((r) => r.id),
    ["obs-1", "obs-3"],
  )
})

test("global filters combine days and category", () => {
  const anchor = new Date("2026-04-21T12:00:00.000Z").getTime()

  const rows: ObservationRow[] = [
    { id: "obs-1", category_id: "cat-bug", published_at: "2026-04-20T10:00:00.000Z" }, // bug, recent
    { id: "obs-2", category_id: "cat-feature", published_at: "2026-04-20T11:00:00.000Z" }, // feature, recent
    { id: "obs-3", category_id: "cat-bug", published_at: "2026-04-01T10:00:00.000Z" }, // bug, old
  ]

  const filtered = applyGlobalFilters(rows, {
    filterDays: 7,
    filterCategoryId: "cat-bug",
    anchor,
  })

  assert.equal(filtered.length, 1, "Combined filter should include only obs-1")
  assert.equal(filtered[0].id, "obs-1")
})
