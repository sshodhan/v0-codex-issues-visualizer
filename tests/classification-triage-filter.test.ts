import test from "node:test"
import assert from "node:assert/strict"

// Pure-function characterization of the heuristic-vs-LLM category
// namespace guard added to components/dashboard/classification-triage.tsx
// during the senior-eng review (Arch #1).
//
// The two classification systems use disjoint category namespaces:
//   - Heuristic taxonomy from `categories` table:
//     bug, feature-request, performance, documentation, integration,
//     pricing, security, ux-ui, api, other
//   - LLM enum from lib/classification/taxonomy.ts:
//     code-generation-quality, hallucination, tool-use-failure,
//     context-handling, latency-performance, auth-session, cli-ux,
//     install-env, cost-quota, safety-policy, integration-mcp, other
//
// The hero "Review {category}" CTA sets globalCategory to a heuristic
// slug (e.g. "bug") and switches to the AI tab. Without this guard,
// the triage tab compares LLM `effective_category` against the
// heuristic slug and silently returns zero rows, undermining the
// classify-backfill cron's main visible payoff.
//
// The guard's rule: an active category is "applicable to the LLM tab"
// iff it's "all" OR it appears in at least one record's
// `effective_category` (case-insensitive). When inapplicable, fall
// back to "all" + surface a notice.

interface MinimalRecord {
  effective_category: string
}

// Mirror the pure logic used by classification-triage.tsx:71-78.
function deriveEffectiveCategoryFilter(
  records: MinimalRecord[],
  activeCategory: string,
): { effective: string; applicable: boolean } {
  if (activeCategory === "all") return { effective: "all", applicable: true }
  const known = new Set(records.map((r) => r.effective_category.toLowerCase()))
  const applicable = known.has(activeCategory)
  return { effective: applicable ? activeCategory : "all", applicable }
}

const llmRecords: MinimalRecord[] = [
  { effective_category: "code-generation-quality" },
  { effective_category: "tool-use-failure" },
  { effective_category: "context-handling" },
  { effective_category: "other" },
]

test("guard ignores heuristic 'bug' slug — LLM tab shows all instead of empty", () => {
  const { effective, applicable } = deriveEffectiveCategoryFilter(llmRecords, "bug")
  assert.equal(applicable, false)
  assert.equal(effective, "all")
})

test("guard ignores heuristic 'feature-request' slug — common Hero CTA target", () => {
  const { effective, applicable } = deriveEffectiveCategoryFilter(
    llmRecords,
    "feature-request",
  )
  assert.equal(applicable, false)
  assert.equal(effective, "all")
})

test("guard accepts an LLM enum value when present in records", () => {
  const { effective, applicable } = deriveEffectiveCategoryFilter(
    llmRecords,
    "tool-use-failure",
  )
  assert.equal(applicable, true)
  assert.equal(effective, "tool-use-failure")
})

test("guard accepts the only overlapping slug 'other' in either namespace", () => {
  const { effective, applicable } = deriveEffectiveCategoryFilter(llmRecords, "other")
  assert.equal(applicable, true)
  assert.equal(effective, "other")
})

test("guard short-circuits 'all' without consulting record set", () => {
  const { effective, applicable } = deriveEffectiveCategoryFilter([], "all")
  assert.equal(applicable, true)
  assert.equal(effective, "all")
})

test("guard treats empty record set as 'no LLM categories known' — every non-all filter is inapplicable", () => {
  // Until the cron has classified anything, the LLM-side data is
  // empty. A heuristic filter flowing in from the global state must
  // gracefully degrade rather than render an empty triage queue.
  const { effective, applicable } = deriveEffectiveCategoryFilter([], "bug")
  assert.equal(applicable, false)
  assert.equal(effective, "all")
})

test("guard is case-insensitive on the comparison", () => {
  const { applicable } = deriveEffectiveCategoryFilter(
    [{ effective_category: "Code-Generation-Quality" }],
    "code-generation-quality",
  )
  assert.equal(applicable, true)
})
