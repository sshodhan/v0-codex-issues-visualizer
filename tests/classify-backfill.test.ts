import test from "node:test"
import assert from "node:assert/strict"

import {
  buildBackfillCandidates,
  type BackfillSourceRow,
} from "../lib/classification/backfill-candidates.ts"

// Covers the pure projection that turns mv_observation_current rows
// into ClassificationCandidate payloads consumed by
// processObservationClassificationQueue. The route handler in
// app/api/cron/classify-backfill/route.ts owns I/O; everything testable
// without Supabase mocking lives here.

const baseRow = (overrides: Partial<BackfillSourceRow> = {}): BackfillSourceRow => ({
  observation_id: "obs-1",
  title: "Codex hangs on startup",
  content: "After updating the CLI, codex sits forever at the prompt.",
  url: "https://example.com/issue/1",
  source_id: "src-reddit",
  cli_version: null,
  fp_os: null,
  fp_shell: null,
  fp_editor: null,
  model_id: null,
  repro_markers: null,
  ...overrides,
})

test("buildBackfillCandidates threads regex env tokens into candidate.env", () => {
  const rows = [
    baseRow({
      cli_version: "1.4.2",
      fp_os: "macos",
      fp_shell: "zsh",
      fp_editor: "vscode",
      model_id: "gpt-5",
    }),
  ]
  const slugs = new Map([["src-reddit", "reddit"]])
  const [candidate] = buildBackfillCandidates(rows, slugs)

  assert.deepEqual(candidate.env, {
    cli_version: "1.4.2",
    os: "macos",
    shell: "zsh",
    editor: "vscode",
    model_id: "gpt-5",
  })
})

test("buildBackfillCandidates omits env entirely when every fingerprint column is null", () => {
  const [candidate] = buildBackfillCandidates([baseRow()], new Map())
  assert.equal(candidate.env, undefined)
})

test("buildBackfillCandidates keeps only non-null env tokens (no empty strings)", () => {
  const [candidate] = buildBackfillCandidates(
    [baseRow({ cli_version: "1.4.2", fp_os: "linux" })],
    new Map(),
  )
  assert.deepEqual(candidate.env, { cli_version: "1.4.2", os: "linux" })
})

test("buildBackfillCandidates sets repro only when repro_markers > 0", () => {
  const [withRepro] = buildBackfillCandidates(
    [baseRow({ repro_markers: 3 })],
    new Map(),
  )
  assert.deepEqual(withRepro.repro, { count: 3 })

  const [zero] = buildBackfillCandidates(
    [baseRow({ repro_markers: 0 })],
    new Map(),
  )
  assert.equal(zero.repro, undefined)

  const [nullCase] = buildBackfillCandidates(
    [baseRow({ repro_markers: null })],
    new Map(),
  )
  assert.equal(nullCase.repro, undefined)
})

test("buildBackfillCandidates resolves source slug into the synthesized report text", () => {
  const slugs = new Map([["src-reddit", "reddit"]])
  const [candidate] = buildBackfillCandidates([baseRow()], slugs)
  assert.match(candidate.reportText, /reddit/)
  assert.match(candidate.reportText, /Codex hangs on startup/)
  assert.match(candidate.reportText, /https:\/\/example\.com\/issue\/1/)
})

test("buildBackfillCandidates falls back to unknown-source when slug map misses", () => {
  const [candidate] = buildBackfillCandidates([baseRow()], new Map())
  assert.match(candidate.reportText, /unknown-source/)
})

test("buildBackfillCandidates handles null source_id without throwing", () => {
  const [candidate] = buildBackfillCandidates(
    [baseRow({ source_id: null })],
    new Map([["src-reddit", "reddit"]]),
  )
  // Should fall through to the unknown-source path rather than crashing
  // on a null lookup.
  assert.match(candidate.reportText, /unknown-source/)
})

test("buildBackfillCandidates passes observationId + title through unchanged for queue dedupe", () => {
  const [candidate] = buildBackfillCandidates(
    [baseRow({ observation_id: "uuid-42", title: "ENOENT during init" })],
    new Map(),
  )
  assert.equal(candidate.observationId, "uuid-42")
  assert.equal(candidate.title, "ENOENT during init")
})
