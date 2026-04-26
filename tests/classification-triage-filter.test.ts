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
//     incomplete_context_overflow, structural_dependency_oversight,
//     tool_invocation_error, dependency_environment_failure,
//     code_generation_bug, hallucinated_code, retrieval_context_mismatch,
//     user_intent_misinterpretation, autonomy_safety_violation,
//     performance_latency_issue, cost_quota_overrun, session_auth_error,
//     cli_user_experience_bug, integration_plugin_failure
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
  { effective_category: "code_generation_bug" },
  { effective_category: "tool_invocation_error" },
  { effective_category: "incomplete_context_overflow" },
  { effective_category: "integration_plugin_failure" },
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
    "tool_invocation_error",
  )
  assert.equal(applicable, true)
  assert.equal(effective, "tool_invocation_error")
})

test("guard keeps working for a valid non-overlapping LLM enum value", () => {
  const { effective, applicable } = deriveEffectiveCategoryFilter(
    llmRecords,
    "integration_plugin_failure",
  )
  assert.equal(applicable, true)
  assert.equal(effective, "integration_plugin_failure")
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
    [{ effective_category: "Code_Generation_Bug" }],
    "code_generation_bug",
  )
  assert.equal(applicable, true)
})
