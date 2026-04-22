import test from "node:test"
import assert from "node:assert/strict"

// Tests for Commit 11: Triage UX + Append Visibility
//
// The triage table must render effective (post-review) state, not baseline.
// This test exercises the logic that the UI uses to determine which fields
// to display. See components/dashboard/classification-triage.tsx.

interface BaselineClassification {
  id: string
  observation_id: string
  category: string
  subcategory: string | null
  severity: string
  status: string
  needs_human_review: boolean
  algorithm_version: string
  created_at: string
}

interface ReviewOverride {
  classification_id: string
  reviewed_category: string | null
  reviewed_severity: string | null
  reviewed_status: string | null
  reviewed_needs_human_review: boolean | null
  reviewed_by: string
  reviewed_at: string
  reviewer_notes: string | null
}

interface EffectiveClassification extends BaselineClassification {
  effective_category: string
  effective_severity: string
  effective_status: string
  effective_needs_human_review: boolean
  latest_review: ReviewOverride | null
}

// Simulates the effective field computation from the API (see
// app/api/classifications/route.ts). The UI reads these effective_* fields.
function computeEffectiveClassification(
  baseline: BaselineClassification,
  review: ReviewOverride | null,
): EffectiveClassification {
  return {
    ...baseline,
    effective_category: review?.reviewed_category ?? baseline.category,
    effective_severity: review?.reviewed_severity ?? baseline.severity,
    effective_status: review?.reviewed_status ?? baseline.status,
    effective_needs_human_review:
      review?.reviewed_needs_human_review ?? baseline.needs_human_review,
    latest_review: review,
  }
}

// Simulates the filter logic from classification-triage.tsx
function filterByEffectiveCategory(
  records: EffectiveClassification[],
  activeCategory: string,
): EffectiveClassification[] {
  if (activeCategory === "all") return records
  return records.filter(
    (r) => r.effective_category.toLowerCase() === activeCategory.toLowerCase(),
  )
}

// Simulates the cluster grouping logic from classification-triage.tsx
function groupByEffectiveCategory(records: EffectiveClassification[]) {
  const grouped = new Map<string, { total: number; highRisk: number }>()
  for (const record of records) {
    const key = `${record.effective_category} › ${record.subcategory || "General"}`
    const current = grouped.get(key) || { total: 0, highRisk: 0 }
    current.total += 1
    if (record.effective_severity === "critical" || record.effective_severity === "high") {
      current.highRisk += 1
    }
    grouped.set(key, current)
  }
  return grouped
}

test("effective state renders review override, not baseline", () => {
  const baseline: BaselineClassification = {
    id: "cls-1",
    observation_id: "obs-1",
    category: "Bug",
    subcategory: "Performance",
    severity: "medium",
    status: "triaged",
    needs_human_review: true,
    algorithm_version: "v1.2",
    created_at: "2026-04-20T10:00:00.000Z",
  }

  const review: ReviewOverride = {
    classification_id: "cls-1",
    reviewed_category: "Feature Request",
    reviewed_severity: "low",
    reviewed_status: "resolved",
    reviewed_needs_human_review: false,
    reviewed_by: "alice@example.com",
    reviewed_at: "2026-04-21T10:00:00.000Z",
    reviewer_notes: "Not a bug, this is expected behavior",
  }

  const effective = computeEffectiveClassification(baseline, review)

  // Effective fields reflect the review override.
  assert.equal(effective.effective_category, "Feature Request")
  assert.equal(effective.effective_severity, "low")
  assert.equal(effective.effective_status, "resolved")
  assert.equal(effective.effective_needs_human_review, false)

  // Baseline fields are preserved for audit trail.
  assert.equal(effective.category, "Bug")
  assert.equal(effective.severity, "medium")
  assert.equal(effective.status, "triaged")
  assert.equal(effective.needs_human_review, true)
})

test("effective state falls back to baseline when no review exists", () => {
  const baseline: BaselineClassification = {
    id: "cls-2",
    observation_id: "obs-2",
    category: "Bug",
    subcategory: null,
    severity: "high",
    status: "new",
    needs_human_review: true,
    algorithm_version: "v1.2",
    created_at: "2026-04-20T11:00:00.000Z",
  }

  const effective = computeEffectiveClassification(baseline, null)

  assert.equal(effective.effective_category, "Bug")
  assert.equal(effective.effective_severity, "high")
  assert.equal(effective.effective_status, "new")
  assert.equal(effective.effective_needs_human_review, true)
  assert.equal(effective.latest_review, null)
})

test("filter chips key on effective_category after review", () => {
  const baseline1: BaselineClassification = {
    id: "cls-1",
    observation_id: "obs-1",
    category: "Bug",
    subcategory: null,
    severity: "high",
    status: "new",
    needs_human_review: true,
    algorithm_version: "v1.2",
    created_at: "2026-04-20T10:00:00.000Z",
  }

  const baseline2: BaselineClassification = {
    id: "cls-2",
    observation_id: "obs-2",
    category: "Feature Request",
    subcategory: null,
    severity: "medium",
    status: "new",
    needs_human_review: false,
    algorithm_version: "v1.2",
    created_at: "2026-04-20T11:00:00.000Z",
  }

  // Reviewer reclassifies cls-1 from Bug to Feature Request.
  const review1: ReviewOverride = {
    classification_id: "cls-1",
    reviewed_category: "Feature Request",
    reviewed_severity: null,
    reviewed_status: null,
    reviewed_needs_human_review: null,
    reviewed_by: "bob@example.com",
    reviewed_at: "2026-04-21T10:00:00.000Z",
    reviewer_notes: null,
  }

  const records = [
    computeEffectiveClassification(baseline1, review1),
    computeEffectiveClassification(baseline2, null),
  ]

  // Filtering by "Bug" should return 0 items (cls-1 is now Feature Request).
  const bugFiltered = filterByEffectiveCategory(records, "bug")
  assert.equal(bugFiltered.length, 0, "Bug filter should find no records after reclassification")

  // Filtering by "Feature Request" should return both items.
  const featureFiltered = filterByEffectiveCategory(records, "feature request")
  assert.equal(featureFiltered.length, 2, "Feature Request filter should find both records")
})

test("cluster grouping uses effective_category and effective_severity", () => {
  const baseline1: BaselineClassification = {
    id: "cls-1",
    observation_id: "obs-1",
    category: "Bug",
    subcategory: "Performance",
    severity: "medium",
    status: "new",
    needs_human_review: true,
    algorithm_version: "v1.2",
    created_at: "2026-04-20T10:00:00.000Z",
  }

  const baseline2: BaselineClassification = {
    id: "cls-2",
    observation_id: "obs-2",
    category: "Bug",
    subcategory: "Performance",
    severity: "low",
    status: "new",
    needs_human_review: false,
    algorithm_version: "v1.2",
    created_at: "2026-04-20T11:00:00.000Z",
  }

  // Reviewer escalates cls-2 severity to critical.
  const review2: ReviewOverride = {
    classification_id: "cls-2",
    reviewed_category: null,
    reviewed_severity: "critical",
    reviewed_status: null,
    reviewed_needs_human_review: null,
    reviewed_by: "carol@example.com",
    reviewed_at: "2026-04-21T10:00:00.000Z",
    reviewer_notes: "This is actually critical",
  }

  const records = [
    computeEffectiveClassification(baseline1, null),
    computeEffectiveClassification(baseline2, review2),
  ]

  const clusters = groupByEffectiveCategory(records)
  const bugPerf = clusters.get("Bug › Performance")

  assert.ok(bugPerf, "Bug › Performance cluster should exist")
  assert.equal(bugPerf.total, 2, "Both records in same cluster")
  assert.equal(bugPerf.highRisk, 1, "One record is now critical (high risk)")
})

test("review history shows baseline with algorithm version", () => {
  const baseline: BaselineClassification = {
    id: "cls-1",
    observation_id: "obs-1",
    category: "Bug",
    subcategory: "Performance",
    severity: "medium",
    status: "new",
    needs_human_review: true,
    algorithm_version: "sentiment-v2.1",
    created_at: "2026-04-20T10:00:00.000Z",
  }

  const review: ReviewOverride = {
    classification_id: "cls-1",
    reviewed_category: "Feature Request",
    reviewed_severity: "low",
    reviewed_status: "resolved",
    reviewed_needs_human_review: false,
    reviewed_by: "alice@example.com",
    reviewed_at: "2026-04-21T10:00:00.000Z",
    reviewer_notes: "Actually a feature request",
  }

  const effective = computeEffectiveClassification(baseline, review)

  // UI should display:
  // - Current effective state: Feature Request, low, resolved
  // - Latest review: alice@example.com at 2026-04-21
  // - Baseline: Bug, medium, new by sentiment-v2.1 at 2026-04-20
  assert.equal(effective.algorithm_version, "sentiment-v2.1")
  assert.equal(effective.created_at, "2026-04-20T10:00:00.000Z")
  assert.ok(effective.latest_review)
  assert.equal(effective.latest_review.reviewed_by, "alice@example.com")
})

test("partial review overrides only affect specified fields", () => {
  const baseline: BaselineClassification = {
    id: "cls-1",
    observation_id: "obs-1",
    category: "Bug",
    subcategory: null,
    severity: "critical",
    status: "new",
    needs_human_review: true,
    algorithm_version: "v1.2",
    created_at: "2026-04-20T10:00:00.000Z",
  }

  // Reviewer only changes severity, leaves other fields null.
  const partialReview: ReviewOverride = {
    classification_id: "cls-1",
    reviewed_category: null,
    reviewed_severity: "low",
    reviewed_status: null,
    reviewed_needs_human_review: null,
    reviewed_by: "dave@example.com",
    reviewed_at: "2026-04-21T10:00:00.000Z",
    reviewer_notes: "Downgrading severity after investigation",
  }

  const effective = computeEffectiveClassification(baseline, partialReview)

  // Only severity changed; category, status, needs_human_review fall back to baseline.
  assert.equal(effective.effective_category, "Bug")
  assert.equal(effective.effective_severity, "low")
  assert.equal(effective.effective_status, "new")
  assert.equal(effective.effective_needs_human_review, true)
})
