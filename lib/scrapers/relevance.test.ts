import test from "node:test"
import assert from "node:assert/strict"

import { evaluateCodexRelevance } from "./relevance.ts"

test("true positives: scoped codex matches pass with a reason", () => {
  const samples = [
    "OpenAI Codex CLI keeps crashing on my mac",
    "Anyone using ChatGPT Codex for TypeScript refactors?",
    "Issue with openai/codex install script",
  ]

  for (const sample of samples) {
    const result = evaluateCodexRelevance(sample)
    assert.equal(result.passed, true, sample)
    assert.ok(result.relevanceReason)
  }
})

test("false positives: broad Copilot business product mentions are excluded", () => {
  const badMatches = [
    "Microsoft Copilot for Sales rollout broke our CRM workflow",
    "Power Platform Copilot pricing is confusing",
    "Copilot for Microsoft 365 security review checklist",
  ]

  for (const sample of badMatches) {
    const result = evaluateCodexRelevance(sample)
    assert.equal(result.passed, false, sample)
    assert.equal(result.relevanceReason, null)
  }
})

test("ambiguous codex mention without scope is filtered out", () => {
  const result = evaluateCodexRelevance(
    "Has anyone read codex sinaiticus in a digital humanities class?"
  )

  assert.equal(result.passed, false)
  assert.equal(result.relevanceReason, null)
})
