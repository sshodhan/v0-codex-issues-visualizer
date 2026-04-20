import test from "node:test"
import assert from "node:assert/strict"

import { evaluateCodexRelevance } from "./relevance.ts"

test("true positives: scoped codex matches pass with a matched: decision", () => {
  const samples = [
    "OpenAI Codex CLI keeps crashing on my mac",
    "Anyone using ChatGPT Codex for TypeScript refactors?",
    "Issue with openai/codex install script",
  ]

  for (const sample of samples) {
    const result = evaluateCodexRelevance(sample)
    assert.equal(result.passed, true, sample)
    assert.ok(result.relevanceReason, sample)
    assert.match(result.decision, /^matched:/, sample)
  }
})

test("false positives: Copilot business-product mentions are excluded with a specific reason", () => {
  const cases: Array<[string, string]> = [
    ["Microsoft Copilot for Sales rollout broke our CRM workflow", "excluded:copilot for sales"],
    ["Power Platform Copilot pricing is confusing", "excluded:power platform copilot"],
    ["Copilot for Microsoft 365 security review checklist", "excluded:copilot for business suite"],
  ]

  for (const [sample, expected] of cases) {
    const result = evaluateCodexRelevance(sample)
    assert.equal(result.passed, false, sample)
    assert.equal(result.relevanceReason, null, sample)
    assert.equal(result.decision, expected, sample)
  }
})

test("ambiguous codex mention without scope is filtered out with no-match decision", () => {
  const result = evaluateCodexRelevance(
    "Has anyone read codex sinaiticus in a digital humanities class?"
  )

  assert.equal(result.passed, false)
  assert.equal(result.relevanceReason, null)
  assert.equal(result.decision, "no-match")
})

test("mixed signal: a scoped include beats a co-mentioned Copilot exclusion", () => {
  // This is the failure mode the evaluator used to have: posts that
  // legitimately mention OpenAI Codex alongside a Microsoft Copilot SKU
  // were dropped by the exclusion-first rule. Include-first keeps them,
  // matching the semantics in scripts/005_add_relevance_reason_and_cleanup.sql.
  const result = evaluateCodexRelevance(
    "OpenAI Codex CLI beats Microsoft Copilot for my TS refactor workflow"
  )

  assert.equal(result.passed, true)
  assert.match(result.decision, /^matched:/)
  assert.ok(result.relevanceReason)
})

test("empty input returns empty-input decision without matching anything", () => {
  const result = evaluateCodexRelevance("   ")

  assert.equal(result.passed, false)
  assert.equal(result.relevanceReason, null)
  assert.equal(result.decision, "empty-input")
})
