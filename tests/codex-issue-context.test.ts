import test from "node:test"
import assert from "node:assert/strict"

import { isCodexSelfReport, readCodexIssueContext } from "../lib/processing-events/codex-issue-context.ts"

test("readCodexIssueContext returns null for legacy events without metadata.codex_issue_context", () => {
  const legacy = { stage: "classification", status: "succeeded" } as Record<string, unknown>
  assert.doesNotThrow(() => readCodexIssueContext(legacy))
  assert.equal(readCodexIssueContext(legacy), null)
})

test("readCodexIssueContext parses codex self-report context", () => {
  const detail = {
    source: "codex-self-report",
    metadata: {
      codex_issue_context: {
        summary: "Crash in dashboard",
        issue_title: "Null deref in renderer",
        issue_number: 321,
        repo: "org/repo",
        run_id: "run-42",
      },
    },
  } as Record<string, unknown>

  assert.equal(isCodexSelfReport(detail), true)
  assert.deepEqual(readCodexIssueContext(detail), {
    summary: "Crash in dashboard",
    issueTitle: "Null deref in renderer",
    issueNumber: 321,
    repo: "org/repo",
    runId: "run-42",
  })
})
