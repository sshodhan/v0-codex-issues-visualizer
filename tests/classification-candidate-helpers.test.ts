import test from "node:test"
import assert from "node:assert/strict"

import {
  buildEnvFromFingerprintColumns,
  buildReproFromFingerprintMarkers,
  synthesizeObservationReportText,
} from "../lib/classification/candidate.ts"

// Covers the deps-free helpers shared by the ingest-time candidate
// builder (lib/scrapers/index.ts → buildClassificationCandidate) and
// the daily backfill cron's mv-row builder
// (lib/classification/backfill-candidates.ts → buildBackfillCandidates).
//
// The two call sites used to inline near-identical logic; the helpers
// were extracted during the senior-eng review (m6) so a future tweak
// to the classifier's env contract can't be forgotten in one path.
// These tests pin the contract on both shapes — string-keyed inputs
// from the BugFingerprint object and from flattened mv columns — so
// either caller's regressions surface here.

test("buildEnvFromFingerprintColumns returns undefined when every token is null/empty", () => {
  assert.equal(buildEnvFromFingerprintColumns({}), undefined)
  assert.equal(
    buildEnvFromFingerprintColumns({
      cli_version: null,
      os: null,
      shell: null,
      editor: null,
      model_id: null,
    }),
    undefined,
  )
  assert.equal(
    buildEnvFromFingerprintColumns({ cli_version: "", os: "" }),
    undefined,
  )
})

test("buildEnvFromFingerprintColumns picks only present tokens", () => {
  assert.deepEqual(
    buildEnvFromFingerprintColumns({ cli_version: "1.4.2", os: "macos" }),
    { cli_version: "1.4.2", os: "macos" },
  )
})

test("buildEnvFromFingerprintColumns maps all five recognized tokens", () => {
  assert.deepEqual(
    buildEnvFromFingerprintColumns({
      cli_version: "1.4.2",
      os: "linux",
      shell: "zsh",
      editor: "vscode",
      model_id: "gpt-5",
    }),
    {
      cli_version: "1.4.2",
      os: "linux",
      shell: "zsh",
      editor: "vscode",
      model_id: "gpt-5",
    },
  )
})

test("buildEnvFromFingerprintColumns ignores unknown keys silently", () => {
  // Future-proofing: callers may pass additional fingerprint columns
  // that aren't part of the env contract yet. Helper must not surface
  // them in env (would inflate the prompt without a schema match).
  const result = buildEnvFromFingerprintColumns({
    cli_version: "1.4.2",
    // @ts-expect-error — testing runtime tolerance to extra keys
    unknown_token: "garbage",
  })
  assert.deepEqual(result, { cli_version: "1.4.2" })
})

test("buildReproFromFingerprintMarkers gates on > 0", () => {
  assert.deepEqual(buildReproFromFingerprintMarkers(3), { count: 3 })
  assert.equal(buildReproFromFingerprintMarkers(0), undefined)
  assert.equal(buildReproFromFingerprintMarkers(null), undefined)
  assert.equal(buildReproFromFingerprintMarkers(undefined), undefined)
})

test("buildReproFromFingerprintMarkers rejects non-integer non-numeric", () => {
  // `typeof null === "object"` → undefined. `typeof "5" === "string"` → undefined.
  // Defensive against accidental Supabase column-type drift.
  // @ts-expect-error — testing runtime tolerance
  assert.equal(buildReproFromFingerprintMarkers("5"), undefined)
  // @ts-expect-error — testing runtime tolerance
  assert.equal(buildReproFromFingerprintMarkers({}), undefined)
})

test("synthesizeObservationReportText falls back to unknown-source on null slug", () => {
  const text = synthesizeObservationReportText({
    title: "ENOENT on startup",
    content: null,
    url: null,
    sourceSlug: null,
  })
  assert.match(text, /unknown-source/)
  assert.match(text, /ENOENT on startup/)
})

test("synthesizeObservationReportText omits Content when missing/blank", () => {
  const text = synthesizeObservationReportText({
    title: "X",
    content: "   ",
    url: "https://example.com",
    sourceSlug: "github",
  })
  assert.doesNotMatch(text, /Content:/)
  assert.match(text, /URL:/)
})

test("ingest-shape and mv-shape produce equivalent env via the helper", () => {
  // Sanity check that the two callers can't diverge on identical
  // signal: the BugFingerprint object uses `os/shell/editor` keys; the
  // mv columns use `fp_os/fp_shell/fp_editor`. Both are mapped to
  // env's `os/shell/editor` by the caller — verified end-to-end.
  const fromIngest = buildEnvFromFingerprintColumns({
    cli_version: "1.4.2",
    os: "linux",
    shell: "bash",
    editor: "neovim",
    model_id: "gpt-5",
  })
  // Backfill caller renames fp_* → bare names before passing in.
  const mvRow = {
    cli_version: "1.4.2",
    fp_os: "linux",
    fp_shell: "bash",
    fp_editor: "neovim",
    model_id: "gpt-5",
  }
  const fromBackfill = buildEnvFromFingerprintColumns({
    cli_version: mvRow.cli_version,
    os: mvRow.fp_os,
    shell: mvRow.fp_shell,
    editor: mvRow.fp_editor,
    model_id: mvRow.model_id,
  })
  assert.deepEqual(fromIngest, fromBackfill)
})
