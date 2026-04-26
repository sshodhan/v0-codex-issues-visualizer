import test from "node:test"
import assert from "node:assert/strict"

import { CLASSIFIER_SYSTEM_PROMPT } from "../lib/classification/prompt.ts"
import {
  CATEGORY_DEFINITIONS,
  CATEGORY_ENUM,
  SUBCATEGORY_EXAMPLES,
} from "../lib/classification/taxonomy.ts"

// Contract tests for the classifier prompt scaffolding.
// The Record<IssueCategory, …> typing on CATEGORY_DEFINITIONS and
// SUBCATEGORY_EXAMPLES already gives us compile-time coverage of the
// enum keys; these runtime tests cover the rendered prompt contents.

const VAGUE_LABELS = new Set(["bug", "issue", "problem", "failure", "error", "other"])

test("every CATEGORY_ENUM value has a non-empty definition", () => {
  for (const slug of CATEGORY_ENUM) {
    const def = CATEGORY_DEFINITIONS[slug]
    assert.ok(def, `missing definition for ${slug}`)
    assert.ok(def.one_liner.length > 0, `${slug}: empty one_liner`)
    assert.ok(def.pick_when.length >= 2, `${slug}: needs at least 2 pick_when entries`)
    assert.ok(def.not_when.length >= 1, `${slug}: needs at least 1 not_when entry`)
  }
})

test("every CATEGORY_ENUM value has at least 4 subcategory examples", () => {
  for (const slug of CATEGORY_ENUM) {
    const examples = SUBCATEGORY_EXAMPLES[slug]
    assert.ok(examples, `missing subcategory examples for ${slug}`)
    assert.ok(
      examples.length >= 4,
      `${slug}: only ${examples.length} subcategory examples (need ≥ 4)`,
    )
  }
})

test("subcategory examples are snake_case and not vague", () => {
  const snakeCase = /^[a-z][a-z0-9_]*$/
  for (const slug of CATEGORY_ENUM) {
    for (const sub of SUBCATEGORY_EXAMPLES[slug]) {
      assert.match(sub, snakeCase, `${slug}.${sub}: must be snake_case`)
      assert.ok(!VAGUE_LABELS.has(sub), `${slug}.${sub}: forbidden vague label`)
      assert.ok(
        !sub.includes(slug),
        `${slug}.${sub}: subcategory must not repeat its category name`,
      )
    }
  }
})

test("rendered prompt mentions every CATEGORY_ENUM value", () => {
  for (const slug of CATEGORY_ENUM) {
    assert.ok(
      CLASSIFIER_SYSTEM_PROMPT.includes(slug),
      `prompt missing category slug: ${slug}`,
    )
  }
})

test("rendered prompt uses autonomy_safety_violation in HARD RULE 5", () => {
  // Regression guard for PR #105: the hard-review trigger renamed from
  // safety-policy → autonomy_safety_violation. Pipeline.applyHardReviewRules
  // matches on this exact string; if the prompt drifts, the model will emit
  // a category the rule no longer fires on.
  assert.ok(
    CLASSIFIER_SYSTEM_PROMPT.includes("category=autonomy_safety_violation"),
    "HARD RULE 5 must reference category=autonomy_safety_violation",
  )
  assert.ok(
    !CLASSIFIER_SYSTEM_PROMPT.includes("safety-policy"),
    "prompt still references the legacy safety-policy slug",
  )
})

test("evidence quote rule mentions verbatim", () => {
  assert.ok(
    /evidence_quotes/i.test(CLASSIFIER_SYSTEM_PROMPT),
    "prompt missing evidence_quotes guidance section",
  )
  assert.ok(
    /verbatim/i.test(CLASSIFIER_SYSTEM_PROMPT),
    "evidence rule must include the word 'verbatim'",
  )
})

test("subcategory guidance forbids vague labels", () => {
  for (const vague of VAGUE_LABELS) {
    const pattern = new RegExp(`\\b${vague}\\b`, "i")
    assert.ok(
      pattern.test(CLASSIFIER_SYSTEM_PROMPT),
      `subcategory guidance must mention forbidden label "${vague}" so the model knows to avoid it`,
    )
  }
})

test("prompt contains at least 4 anchored few-shot examples", () => {
  const exampleHeaders = CLASSIFIER_SYSTEM_PROMPT.match(/Example [A-Z] —/g) ?? []
  assert.ok(
    exampleHeaders.length >= 4,
    `expected ≥ 4 worked examples, found ${exampleHeaders.length}`,
  )
})

test("prompt does not reference any legacy v1 category slug", () => {
  const legacy = [
    "code-generation-quality",
    "tool-use-failure",
    "context-handling",
    "latency-performance",
    "auth-session",
    "cli-ux",
    "install-env",
    "cost-quota",
    "integration-mcp",
  ]
  for (const slug of legacy) {
    assert.ok(
      !CLASSIFIER_SYSTEM_PROMPT.includes(slug),
      `prompt still references legacy slug: ${slug}`,
    )
  }
})

test("strict schema constrains alternate_categories to CATEGORY_ENUM", async () => {
  const { CLASSIFICATION_SCHEMA, validateEnumFields } = await import(
    "../lib/classification/schema.ts"
  )
  const altSchema = (CLASSIFICATION_SCHEMA.schema.properties as Record<string, unknown>)
    .alternate_categories as { items?: { enum?: readonly string[] } }
  assert.ok(altSchema.items?.enum, "alternate_categories.items.enum missing")
  assert.deepEqual(altSchema.items.enum, CATEGORY_ENUM)

  // validateEnumFields rejects payloads with a legacy alternate slug.
  const validBase = {
    category: CATEGORY_ENUM[0],
    severity: "medium",
    status: "new",
    reproducibility: "always",
    impact: "single-user",
    alternate_categories: [CATEGORY_ENUM[1]],
  }
  assert.equal(validateEnumFields(validBase), null, "valid payload should pass")

  const withLegacyAlt = { ...validBase, alternate_categories: ["safety-policy"] }
  const result = validateEnumFields(withLegacyAlt)
  assert.ok(result, "legacy alternate slug must be rejected")
  assert.equal(result?.field, "alternate_categories")
})
