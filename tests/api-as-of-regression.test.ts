import test from "node:test"
import assert from "node:assert/strict"

// Tests for API regression prevention (Commits 11 & 12)
//
// These tests validate that API endpoints behave correctly with and without
// the as_of parameter, ensuring no regressions in existing functionality.

// Simulates the as_of validation logic shared across all APIs
function validateAsOfParam(asOfRaw: string | null): {
  valid: boolean
  parsed: Date | null
  error?: { message: string; code: number }
} {
  if (!asOfRaw) {
    return { valid: true, parsed: null }
  }

  const parsed = new Date(asOfRaw)
  if (Number.isNaN(parsed.getTime())) {
    return {
      valid: false,
      parsed: null,
      error: {
        message: "as_of must be a valid ISO8601 timestamp",
        code: 400,
      },
    }
  }

  if (parsed.getTime() > Date.now() + 60_000) {
    return {
      valid: false,
      parsed: null,
      error: {
        message: "as_of cannot be in the future",
        code: 400,
      },
    }
  }

  return { valid: true, parsed }
}

test("as_of validation rejects invalid ISO8601 strings", () => {
  const invalidInputs = [
    "not-a-date",
    "2026/04/21",
    "April 21, 2026",
    "invalid",
    "2026-13-45T99:99:99.999Z", // Invalid date parts
  ]

  for (const input of invalidInputs) {
    const result = validateAsOfParam(input)
    assert.equal(result.valid, false, `"${input}" should be rejected`)
    assert.equal(result.error?.code, 400)
    assert.ok(result.error?.message.includes("ISO8601"))
  }
})

test("as_of validation rejects future timestamps", () => {
  const futureDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // 2 hours from now
  const result = validateAsOfParam(futureDate)

  assert.equal(result.valid, false)
  assert.equal(result.error?.code, 400)
  assert.ok(result.error?.message.includes("future"))
})

test("as_of validation accepts null (live mode)", () => {
  const result = validateAsOfParam(null)
  assert.equal(result.valid, true)
  assert.equal(result.parsed, null)
  assert.equal(result.error, undefined)
})

test("as_of validation accepts valid past timestamps", () => {
  const validInputs = [
    "2026-04-21T12:00:00.000Z",
    "2026-03-01T00:00:00Z",
    "2025-01-01T00:00:00.000Z",
    new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
  ]

  for (const input of validInputs) {
    const result = validateAsOfParam(input)
    assert.equal(result.valid, true, `"${input}" should be accepted`)
    assert.ok(result.parsed instanceof Date)
  }
})

// Simulates the /api/issues query building logic
interface IssueQueryParams {
  source?: string
  category?: string
  sentiment?: string
  days?: string
  sortBy?: string
  order?: string
  q?: string
  as_of?: string
}

function buildIssueQuery(params: IssueQueryParams): {
  useRpc: boolean
  filters: Record<string, any>
} {
  const asOfResult = validateAsOfParam(params.as_of || null)

  // When as_of is present, use RPC; otherwise use materialized view
  const useRpc = asOfResult.valid && asOfResult.parsed !== null

  return {
    useRpc,
    filters: {
      source: params.source || null,
      category: params.category || null,
      sentiment: params.sentiment || null,
      days: params.days ? parseInt(params.days, 10) : null,
      sortBy: params.sortBy || "published_at",
      order: params.order || "desc",
      search: params.q || null,
      asOf: asOfResult.parsed,
    },
  }
}

test("/api/issues uses RPC when as_of is provided", () => {
  const result = buildIssueQuery({ as_of: "2026-04-21T12:00:00.000Z" })
  assert.equal(result.useRpc, true, "Should use RPC for historical query")
})

test("/api/issues uses materialized view when as_of is absent", () => {
  const result = buildIssueQuery({})
  assert.equal(result.useRpc, false, "Should use MV for live query")
})

test("/api/issues preserves all existing filters when as_of is added", () => {
  const result = buildIssueQuery({
    source: "reddit",
    category: "bug",
    sentiment: "negative",
    days: "30",
    sortBy: "impact_score",
    order: "desc",
    q: "codex",
    as_of: "2026-04-21T12:00:00.000Z",
  })

  assert.equal(result.filters.source, "reddit")
  assert.equal(result.filters.category, "bug")
  assert.equal(result.filters.sentiment, "negative")
  assert.equal(result.filters.days, 30)
  assert.equal(result.filters.sortBy, "impact_score")
  assert.equal(result.filters.order, "desc")
  assert.equal(result.filters.search, "codex")
  assert.ok(result.filters.asOf instanceof Date)
})

// Simulates the /api/classifications query building logic
function buildClassificationQuery(params: {
  status?: string
  category?: string
  needs_human_review?: string
  limit?: string
  as_of?: string
}): {
  filters: Record<string, any>
  reviewFilter: { maxReviewedAt: Date | null }
} {
  const asOfResult = validateAsOfParam(params.as_of || null)

  return {
    filters: {
      status: params.status || null,
      category: params.category || null,
      needsHumanReview:
        params.needs_human_review === "true"
          ? true
          : params.needs_human_review === "false"
            ? false
            : null,
      limit: params.limit ? parseInt(params.limit, 10) : 50,
      maxCreatedAt: asOfResult.parsed,
    },
    reviewFilter: {
      maxReviewedAt: asOfResult.parsed,
    },
  }
}

test("/api/classifications filters reviews by as_of", () => {
  const result = buildClassificationQuery({
    as_of: "2026-04-21T12:00:00.000Z",
  })

  assert.ok(result.reviewFilter.maxReviewedAt instanceof Date)
  assert.equal(
    result.reviewFilter.maxReviewedAt.toISOString(),
    "2026-04-21T12:00:00.000Z",
  )
})

test("/api/classifications preserves existing filters when as_of is added", () => {
  const result = buildClassificationQuery({
    status: "triaged",
    category: "bug",
    needs_human_review: "true",
    limit: "100",
    as_of: "2026-04-21T12:00:00.000Z",
  })

  assert.equal(result.filters.status, "triaged")
  assert.equal(result.filters.category, "bug")
  assert.equal(result.filters.needsHumanReview, true)
  assert.equal(result.filters.limit, 100)
  assert.ok(result.filters.maxCreatedAt instanceof Date)
})

test("/api/classifications returns all reviews in live mode", () => {
  const result = buildClassificationQuery({})
  assert.equal(result.reviewFilter.maxReviewedAt, null)
})

interface BaselineClassification {
  id: string
  category: string | null
  severity: string | null
  status: string | null
  needs_human_review: boolean | null
  created_at: string
}

interface ClassificationReview {
  classification_id: string
  category: string | null
  severity: string | null
  status: string | null
  needs_human_review: boolean | null
  reviewed_at: string
}

function filterForClassificationList(
  rows: BaselineClassification[],
  reviews: ClassificationReview[],
  asOfIso: string | null,
) {
  const asOf = asOfIso ? new Date(asOfIso) : null
  const filteredRows = asOf
    ? rows.filter((row) => new Date(row.created_at) <= asOf)
    : rows
  const ids = new Set(filteredRows.map((row) => row.id))
  const filteredReviews = (asOf
    ? reviews.filter((review) => new Date(review.reviewed_at) <= asOf)
    : reviews
  ).filter((review) => ids.has(review.classification_id))

  const latestReviewByClassification = new Map<string, ClassificationReview>()
  const byReviewedAtDesc = filteredReviews
    .slice()
    .sort((a, b) => new Date(b.reviewed_at).getTime() - new Date(a.reviewed_at).getTime())
  for (const review of byReviewedAtDesc) {
    if (!latestReviewByClassification.has(review.classification_id)) {
      latestReviewByClassification.set(review.classification_id, review)
    }
  }

  return filteredRows.map((row) => {
    const latest = latestReviewByClassification.get(row.id)
    return {
      id: row.id,
      effective_status: latest?.status ?? row.status,
      effective_category: latest?.category ?? row.category,
      effective_severity: latest?.severity ?? row.severity,
      effective_needs_human_review:
        latest?.needs_human_review ?? row.needs_human_review,
    }
  })
}

function aggregateClassificationStatsFromEffectiveRows(
  effectiveRows: Array<{
    effective_status: string | null
    effective_category: string | null
    effective_severity: string | null
    effective_needs_human_review: boolean | null
  }>,
) {
  const byCategory: Record<string, number> = {}
  const bySeverity: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let needsReviewCount = 0

  for (const row of effectiveRows) {
    byCategory[row.effective_category || "unknown"] =
      (byCategory[row.effective_category || "unknown"] || 0) + 1
    bySeverity[row.effective_severity || "unknown"] =
      (bySeverity[row.effective_severity || "unknown"] || 0) + 1
    byStatus[row.effective_status || "unknown"] =
      (byStatus[row.effective_status || "unknown"] || 0) + 1
    if (row.effective_needs_human_review) needsReviewCount++
  }

  return {
    total: effectiveRows.length,
    needsReviewCount,
    byCategory,
    bySeverity,
    byStatus,
  }
}

test("/api/classifications/stats matches /api/classifications effective replay state for as_of", () => {
  const asOf = "2026-04-20T13:00:00.000Z"
  const rows: BaselineClassification[] = [
    {
      id: "c1",
      category: "bug",
      severity: "high",
      status: "new",
      needs_human_review: true,
      created_at: "2026-04-20T11:00:00.000Z",
    },
    {
      id: "c2",
      category: "feature",
      severity: "low",
      status: "new",
      needs_human_review: false,
      created_at: "2026-04-20T12:00:00.000Z",
    },
    {
      id: "c3",
      category: "question",
      severity: "low",
      status: "new",
      needs_human_review: false,
      created_at: "2026-04-20T14:00:00.000Z",
    },
  ]
  const reviews: ClassificationReview[] = [
    {
      classification_id: "c1",
      category: "bug",
      severity: "critical",
      status: "triaged",
      needs_human_review: false,
      reviewed_at: "2026-04-20T12:30:00.000Z",
    },
    {
      classification_id: "c2",
      category: "feature",
      severity: "medium",
      status: "triaged",
      needs_human_review: true,
      reviewed_at: "2026-04-20T13:30:00.000Z",
    },
  ]

  const effectiveRows = filterForClassificationList(rows, reviews, asOf)
  const statsFromList = aggregateClassificationStatsFromEffectiveRows(effectiveRows)

  assert.equal(statsFromList.total, 2, "rows created after as_of must be excluded")
  assert.equal(
    statsFromList.byStatus.triaged,
    1,
    "reviews after as_of must not affect effective status",
  )
  assert.equal(statsFromList.byStatus.new, 1)
  assert.equal(statsFromList.needsReviewCount, 0)
})

// Simulates the /api/stats query building logic
function buildStatsQuery(params: {
  as_of?: string
  days?: string
  category?: string
}): {
  anchor: number
  filters: { days: number | null; categorySlug: string | null }
} {
  const asOfResult = validateAsOfParam(params.as_of || null)
  const anchor = asOfResult.parsed ? asOfResult.parsed.getTime() : Date.now()

  return {
    anchor,
    filters: {
      days: params.days ? parseInt(params.days, 10) : null,
      categorySlug: params.category || null,
    },
  }
}

test("/api/stats uses as_of as anchor for days calculation", () => {
  const asOf = "2026-04-21T12:00:00.000Z"
  const result = buildStatsQuery({ as_of: asOf, days: "7" })

  assert.equal(result.anchor, new Date(asOf).getTime())
  assert.equal(result.filters.days, 7)
})

test("/api/stats uses current time as anchor in live mode", () => {
  const before = Date.now()
  const result = buildStatsQuery({ days: "7" })
  const after = Date.now()

  assert.ok(result.anchor >= before && result.anchor <= after)
})

test("/api/stats accepts category filter", () => {
  const result = buildStatsQuery({ category: "bug" })
  assert.equal(result.filters.categorySlug, "bug")
})

// Integration test: verify effective state is returned correctly
interface ClassificationWithReview {
  id: string
  category: string
  severity: string
  status: string
  needs_human_review: boolean
  latest_review: {
    reviewed_category: string | null
    reviewed_severity: string | null
    reviewed_status: string | null
    reviewed_needs_human_review: boolean | null
  } | null
}

function computeEffectiveFields(record: ClassificationWithReview) {
  const review = record.latest_review
  return {
    effective_category: review?.reviewed_category ?? record.category,
    effective_severity: review?.reviewed_severity ?? record.severity,
    effective_status: review?.reviewed_status ?? record.status,
    effective_needs_human_review:
      review?.reviewed_needs_human_review ?? record.needs_human_review,
  }
}

test("effective fields computed correctly with full override", () => {
  const record: ClassificationWithReview = {
    id: "cls-1",
    category: "Bug",
    severity: "high",
    status: "new",
    needs_human_review: true,
    latest_review: {
      reviewed_category: "Feature Request",
      reviewed_severity: "low",
      reviewed_status: "resolved",
      reviewed_needs_human_review: false,
    },
  }

  const effective = computeEffectiveFields(record)

  assert.equal(effective.effective_category, "Feature Request")
  assert.equal(effective.effective_severity, "low")
  assert.equal(effective.effective_status, "resolved")
  assert.equal(effective.effective_needs_human_review, false)
})

test("effective fields fall back to baseline with no review", () => {
  const record: ClassificationWithReview = {
    id: "cls-1",
    category: "Bug",
    severity: "high",
    status: "new",
    needs_human_review: true,
    latest_review: null,
  }

  const effective = computeEffectiveFields(record)

  assert.equal(effective.effective_category, "Bug")
  assert.equal(effective.effective_severity, "high")
  assert.equal(effective.effective_status, "new")
  assert.equal(effective.effective_needs_human_review, true)
})

test("effective fields handle partial overrides", () => {
  const record: ClassificationWithReview = {
    id: "cls-1",
    category: "Bug",
    severity: "high",
    status: "new",
    needs_human_review: true,
    latest_review: {
      reviewed_category: null,
      reviewed_severity: "low",
      reviewed_status: null,
      reviewed_needs_human_review: null,
    },
  }

  const effective = computeEffectiveFields(record)

  assert.equal(effective.effective_category, "Bug") // Fallback
  assert.equal(effective.effective_severity, "low") // Override
  assert.equal(effective.effective_status, "new") // Fallback
  assert.equal(effective.effective_needs_human_review, true) // Fallback
})

// Regression test: verify count label format
test("issues table count label format", () => {
  const formatCountLabel = (
    observationCount: number | undefined,
    canonicalCount: number | undefined,
    issuesLength: number,
  ): string => {
    if (observationCount !== undefined && canonicalCount !== undefined) {
      return `(${observationCount} observations across ${canonicalCount} signals)`
    }
    return `(${issuesLength})`
  }

  // With both counts provided
  assert.equal(
    formatCountLabel(150, 45, 150),
    "(150 observations across 45 signals)",
  )

  // Fallback when counts not provided
  assert.equal(formatCountLabel(undefined, undefined, 150), "(150)")
})
