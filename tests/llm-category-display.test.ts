import test from "node:test"
import assert from "node:assert/strict"

import {
  formatSubcategoryLabel,
  formatTriageGroupSlug,
  llmCategoryLabel,
  triageGroupParts,
} from "../lib/classification/llm-category-display.ts"
import { CATEGORY_ENUM } from "../lib/classification/taxonomy.ts"

test("llmCategoryLabel returns the curated label for known enum slugs", () => {
  assert.equal(llmCategoryLabel("code_generation_bug"), "Code generation bug")
  assert.equal(llmCategoryLabel("cli_user_experience_bug"), "CLI / UX bug")
})

test("llmCategoryLabel covers every CATEGORY_ENUM value with a non-empty string", () => {
  // Guards against an enum value being added in taxonomy.ts without a
  // matching entry here AND without the humanize fallback being able to
  // produce something readable. (`output_content_safety`, added by the
  // sibling PR, is the motivating case.)
  for (const slug of CATEGORY_ENUM) {
    const label = llmCategoryLabel(slug)
    assert.ok(label.length > 0, `${slug}: empty label`)
    assert.notEqual(label, slug, `${slug}: label should not be the raw slug`)
  }
})

test("llmCategoryLabel falls back to a humanized form for unknown slugs", () => {
  // A new enum value can land in CATEGORY_ENUM before its hand-tuned
  // entry is added to LLM_CATEGORY_LABELS — make sure reviewers don't
  // see raw `output_content_safety` in the meantime.
  assert.equal(llmCategoryLabel("output_content_safety"), "Output content safety")
  assert.equal(llmCategoryLabel("brand_new_thing"), "Brand new thing")
})

test("llmCategoryLabel returns the input unchanged when empty", () => {
  assert.equal(llmCategoryLabel(""), "")
})

test("formatSubcategoryLabel title-cases snake_case slugs", () => {
  assert.equal(formatSubcategoryLabel("missing_dependency"), "Missing Dependency")
  assert.equal(formatSubcategoryLabel("token_expired"), "Token Expired")
})

test("formatSubcategoryLabel handles kebab-case and mixed delimiters", () => {
  assert.equal(formatSubcategoryLabel("slow-response"), "Slow Response")
  assert.equal(formatSubcategoryLabel("foo_bar-baz"), "Foo Bar Baz")
})

test("formatSubcategoryLabel returns 'General' for null/undefined/empty input", () => {
  assert.equal(formatSubcategoryLabel(null), "General")
  assert.equal(formatSubcategoryLabel(undefined), "General")
  assert.equal(formatSubcategoryLabel(""), "General")
})

test("formatSubcategoryLabel collapses repeated delimiters", () => {
  // Defensive — the prompt schema enforces snake_case but reviewer
  // overrides go through the open-ended subcategory_override Input.
  assert.equal(formatSubcategoryLabel("foo__bar"), "Foo Bar")
  assert.equal(formatSubcategoryLabel("--lead-trail--"), "Lead Trail")
})

test("triageGroupParts builds raw + label using both formatters", () => {
  const parts = triageGroupParts({
    category: "code_generation_bug",
    subcategory: "syntax_error",
  })
  assert.equal(parts.raw, "code_generation_bug › syntax_error")
  assert.equal(parts.label, "Code generation bug › Syntax Error")
  assert.equal(parts.rawCategory, "code_generation_bug")
  assert.equal(parts.rawSubcategory, "syntax_error")
})

test("triageGroupParts uses 'General' as the missing-subcategory sentinel in raw + label", () => {
  // Equality on `raw` powers the group filter, so the sentinel must be
  // stable. The label side mirrors it for reviewer display.
  const fromNull = triageGroupParts({ category: "tool_invocation_error", subcategory: null })
  const fromEmpty = triageGroupParts({ category: "tool_invocation_error", subcategory: "" })
  assert.equal(fromNull.raw, "tool_invocation_error › General")
  assert.equal(fromNull.label, "Tool invocation error › General")
  assert.equal(fromNull.rawSubcategory, "General")
  assert.deepEqual(fromNull, fromEmpty)
})

test("triageGroupParts humanizes unknown category slugs end-to-end", () => {
  const parts = triageGroupParts({
    category: "output_content_safety",
    subcategory: "pii_or_secret_in_output",
  })
  assert.equal(parts.label, "Output content safety › Pii Or Secret In Output")
  assert.equal(parts.raw, "output_content_safety › pii_or_secret_in_output")
})

test("formatTriageGroupSlug joins both slugs when both are real", () => {
  assert.equal(
    formatTriageGroupSlug("code_generation_bug", "syntax_error"),
    "code_generation_bug › syntax_error",
  )
})

test("formatTriageGroupSlug drops the General sentinel so the tooltip never claims a placeholder is a slug", () => {
  // This is the contract that keeps the chip + breadcrumb tooltips
  // honest. The row-cell tooltip already special-cases null
  // subcategory; this helper does the equivalent for composite group
  // tooltips that come from `triageGroupParts`.
  assert.equal(
    formatTriageGroupSlug("tool_invocation_error", "General"),
    "tool_invocation_error (no subcategory)",
  )
})

test("formatTriageGroupSlug round-trips with triageGroupParts", () => {
  const realPair = triageGroupParts({
    category: "code_generation_bug",
    subcategory: "syntax_error",
  })
  assert.equal(
    formatTriageGroupSlug(realPair.rawCategory, realPair.rawSubcategory),
    realPair.raw,
  )
  // Missing subcategory: parts.raw still embeds "General" (filter key
  // stability), but the tooltip helper drops it.
  const missingSubcategory = triageGroupParts({
    category: "tool_invocation_error",
    subcategory: null,
  })
  assert.equal(missingSubcategory.raw, "tool_invocation_error › General")
  assert.equal(
    formatTriageGroupSlug(missingSubcategory.rawCategory, missingSubcategory.rawSubcategory),
    "tool_invocation_error (no subcategory)",
  )
})
