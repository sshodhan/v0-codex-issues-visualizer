import test from "node:test"
import assert from "node:assert/strict"

import {
  EMPTY_FINGERPRINT,
  buildCompoundClusterKey,
  compoundKeyMatchesErrorCode,
  computeCompoundKey,
  extractBugFingerprint,
} from "./bug-fingerprint.ts"
import { buildTitleClusterKey } from "../storage/cluster-key.ts"

// ---------------------------------------------------------------------------
// Error-code extraction
// ---------------------------------------------------------------------------

test("extracts POSIX errno from body text", () => {
  const fp = extractBugFingerprint({
    title: "Codex crashes on startup",
    content: "Error: ENOENT: no such file or directory, open '/Users/a/.codex/config.yaml'",
  })
  assert.equal(fp.error_code, "ENOENT")
})

test("extracts EACCES distinct from ENOENT so identical titles split", () => {
  const fpEnoent = extractBugFingerprint({
    title: "Codex crashes on startup",
    content: "ENOENT: missing config",
  })
  const fpEacces = extractBugFingerprint({
    title: "Codex crashes on startup",
    content: "EACCES: permission denied writing to /usr/local/lib",
  })
  assert.equal(fpEnoent.error_code, "ENOENT")
  assert.equal(fpEacces.error_code, "EACCES")
  assert.notEqual(
    buildCompoundClusterKey("Codex crashes on startup", fpEnoent),
    buildCompoundClusterKey("Codex crashes on startup", fpEacces),
  )
})

test("rejects common false-positive errno-shaped words via whitelist", () => {
  // "EMAIL" matches /\bE[A-Z]{2,10}\b/ but is not a POSIX errno.
  const fp = extractBugFingerprint({
    title: "Codex EMAIL feature",
    content: "Can I connect EMAIL and SLACK to codex?",
  })
  assert.equal(fp.error_code, null)
})

test("extracts Python exception class when a traceback context is present", () => {
  const fp = extractBugFingerprint({
    title: "Codex fails on long prompts",
    content: "Traceback (most recent call last):\n  File \"/a/b/c.py\", line 42, in main\n    raise ValueError('too long')\nValueError: too long",
  })
  assert.equal(fp.error_code, "ValueError")
})

test("bare Python exception name in prose does NOT shadow a more-specific HTTP code", () => {
  // Data-analyst finding: without a traceback gate, "ConnectionError"
  // wins over HTTP 429 even when the HTTP code is the actionable signal.
  const fp = extractBugFingerprint({
    title: "codex upload fails",
    content: "I get a ConnectionError in my logs after the server returns http 429 for a while",
  })
  assert.equal(fp.error_code, "HTTP_429")
})

test("extracts JS TypeError", () => {
  const fp = extractBugFingerprint({
    title: "Codex CLI crash",
    content: "TypeError: Cannot read properties of undefined (reading 'map')",
  })
  assert.equal(fp.error_code, "TypeError")
})

test("extracts HTTP status as HTTP_<N>", () => {
  const fp = extractBugFingerprint({
    title: "Codex rate limits me",
    content: "got HTTP 429 from the Responses API",
  })
  assert.equal(fp.error_code, "HTTP_429")
})

test("HTTP regex does not false-positive on bare three-digit numbers in prose", () => {
  // "waited 500ms" / "line 429" used to produce HTTP_500 / HTTP_429.
  const fp = extractBugFingerprint({
    title: "codex slow",
    content: "the client waited 500ms and line 429 in my script threw nothing useful",
  })
  assert.equal(fp.error_code, null)
})

test("extracts exit code as EXIT_<N>", () => {
  const fp = extractBugFingerprint({
    title: "codex exec dies",
    content: "process exited with code 137",
  })
  assert.equal(fp.error_code, "EXIT_137")
})

test("exit-code regex does not false-positive on time prose", () => {
  // "exited 12 minutes ago" used to produce EXIT_12.
  const fp = extractBugFingerprint({
    title: "my codex session",
    content: "I exited 12 minutes ago and came back to a broken prompt",
  })
  assert.equal(fp.error_code, null)
})

// ---------------------------------------------------------------------------
// Stack-frame extraction
// ---------------------------------------------------------------------------

test("extracts Python frame and normalizes path to last two segments", () => {
  const fp = extractBugFingerprint({
    title: "codex explodes",
    content: 'File "/home/alice/work/codex/src/agent/loop.py", line 217, in step',
  })
  assert.equal(fp.top_stack_frame, "agent/loop.py:217")
  assert.ok(fp.top_stack_frame_hash && fp.top_stack_frame_hash.length === 12)
})

test("extracts JS `at` frame and normalizes path to last two segments", () => {
  const fp = extractBugFingerprint({
    title: "codex explodes",
    content: "    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n    at async main (/srv/codex/dist/cli.js:12:9)",
  })
  // `node:internal/process/task_queues` → split on `/` → last two segments.
  assert.equal(fp.top_stack_frame, "process/task_queues:95")
})

test("identical titles with different stack frames produce different compound keys", () => {
  const a = extractBugFingerprint({
    title: "Codex hangs",
    content: 'File "/a/b/src/tokenizer.py", line 88',
  })
  const b = extractBugFingerprint({
    title: "Codex hangs",
    content: 'File "/a/b/src/inference.py", line 314',
  })
  assert.notEqual(
    buildCompoundClusterKey("Codex hangs", a),
    buildCompoundClusterKey("Codex hangs", b),
  )
})

// ---------------------------------------------------------------------------
// Environment extraction
// ---------------------------------------------------------------------------

test("extracts CLI semver near the word 'codex'", () => {
  const fp = extractBugFingerprint({
    title: "codex cli regression",
    content: "codex version 0.12.3 broke things that worked in 0.12.2",
  })
  assert.equal(fp.cli_version, "0.12.3")
})

test("extracts OS, shell, editor, model id", () => {
  const fp = extractBugFingerprint({
    title: "codex breaks in VS Code",
    content: "macOS Sonoma + zsh, codex CLI inside VS Code, using gpt-5-mini for planning",
  })
  assert.equal(fp.os, "macos")
  assert.equal(fp.shell, "zsh")
  assert.equal(fp.editor, "vscode")
  assert.equal(fp.model_id, "gpt-5-mini")
})

test("OS detection distinguishes wsl from linux", () => {
  const fp = extractBugFingerprint({
    title: "codex fails",
    content: "Running on Ubuntu under WSL2",
  })
  assert.equal(fp.os, "wsl")
})

// ---------------------------------------------------------------------------
// Repro markers + keyword presence
// ---------------------------------------------------------------------------

test("counts repro markers", () => {
  const fp = extractBugFingerprint({
    title: "crash on launch",
    content: "Steps to reproduce:\n1. install\n2. run codex\nHow to reproduce: same thing. Repro: yes.",
  })
  assert.ok(fp.repro_markers >= 3)
})

test("reuses analyzeSentiment's keyword_presence counter", () => {
  const fp = extractBugFingerprint({
    title: "bug in the thing",
    content: "this is an error and a regression, the feature is broken and fails",
  })
  assert.ok(fp.keyword_presence >= 4)
})

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

test("returns empty-like fingerprint when content is null", () => {
  const fp = extractBugFingerprint({ title: "Codex crash", content: null })
  assert.equal(fp.error_code, null)
  assert.equal(fp.top_stack_frame, null)
  assert.equal(fp.top_stack_frame_hash, null)
  assert.equal(fp.os, null)
})

test("compound key falls back to title-only when fingerprint has no differentiator", () => {
  const blank = { ...EMPTY_FINGERPRINT }
  assert.equal(
    buildCompoundClusterKey("Codex crashes on startup", blank),
    buildTitleClusterKey("Codex crashes on startup"),
  )
})

test("compound key falls back to title-only when fingerprint is null", () => {
  assert.equal(
    buildCompoundClusterKey("Codex crashes on startup", null),
    buildTitleClusterKey("Codex crashes on startup"),
  )
})

test("empty title still collapses to title:empty", () => {
  assert.equal(buildCompoundClusterKey("", null), "title:empty")
  assert.equal(buildCompoundClusterKey("   ", EMPTY_FINGERPRINT), "title:empty")
})

test("unicode title is preserved, not collapsed", () => {
  const jp = buildCompoundClusterKey("Codexがクラッシュする", null)
  const en = buildCompoundClusterKey("Codex crashes", null)
  assert.notEqual(jp, "title:empty")
  assert.notEqual(jp, en)
})

test("compound key is pure regex — the LLM classification is not part of it", () => {
  // Decision (post-review): cluster-key labels stay deterministic and
  // regex-only. The LLM classifier's output lives in `classifications`
  // and is joined into mv_observation_current at read time, not mixed
  // into the fingerprint row or the cluster-key label. Locking this
  // contract in a test so the LLM path cannot re-infiltrate the key
  // via a future refactor.
  const withError = {
    ...EMPTY_FINGERPRINT,
    error_code: "ENOENT",
  }
  const withoutError = { ...EMPTY_FINGERPRINT }
  assert.ok(buildCompoundClusterKey("Codex fails", withError).includes("err:ENOENT"))
  assert.equal(
    buildCompoundClusterKey("Codex fails", withoutError),
    buildTitleClusterKey("Codex fails"),
  )
})

// ---------------------------------------------------------------------------
// Stack-frame hash stability under line-number drift
// ---------------------------------------------------------------------------

test("stack-frame hash is stable across one-line shifts of the same file", () => {
  // Codex ships a new release; the same bug surfaces one line lower in the
  // same file. The display string differs but the cluster-key hash should
  // match so duplicates still collapse.
  const fpA = extractBugFingerprint({
    title: "codex hangs",
    content: 'File "/a/b/src/agent/loop.py", line 217, in step',
  })
  const fpB = extractBugFingerprint({
    title: "codex hangs",
    content: 'File "/a/b/src/agent/loop.py", line 218, in step',
  })
  assert.equal(fpA.top_stack_frame_hash, fpB.top_stack_frame_hash)
  assert.notEqual(fpA.top_stack_frame, fpB.top_stack_frame)
})

// ---------------------------------------------------------------------------
// computeCompoundKey — single read-time source of truth for the label
// ---------------------------------------------------------------------------

function makeMockSupabase(
  observation: { title?: string } | null,
  fingerprint: Record<string, unknown> | null,
) {
  return {
    from(table: string) {
      if (table === "observations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: observation, error: null }),
            }),
          }),
        }
      }
      if (table === "bug_fingerprints") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: fingerprint, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as any
}

test("computeCompoundKey derives label from observations + latest bug_fingerprints row", async () => {
  const supabase = makeMockSupabase(
    { title: "Codex crashes on startup" },
    {
      error_code: "ENOENT",
      top_stack_frame: "src/cli.ts:14",
      top_stack_frame_hash: "abc123def456",
      cli_version: "1.2.3",
      os: "macos",
      shell: "zsh",
      editor: "vscode",
      model_id: "gpt-5-mini",
      repro_markers: 2,
      keyword_presence: 4,
    },
  )

  const key = await computeCompoundKey(supabase, "00000000-0000-0000-0000-000000000001")
  assert.ok(key)
  assert.ok(key!.includes("|err:ENOENT"))
  assert.ok(key!.includes("|frame:abc123def456"))
  assert.ok(key!.startsWith("title:"))
})

test("computeCompoundKey degrades to title-only when no fingerprint row exists", async () => {
  const supabase = makeMockSupabase({ title: "Codex crashes on startup" }, null)
  const key = await computeCompoundKey(supabase, "00000000-0000-0000-0000-000000000002")
  assert.ok(key)
  assert.equal(key, buildTitleClusterKey("Codex crashes on startup"))
  assert.ok(!key!.includes("|err:"))
  assert.ok(!key!.includes("|frame:"))
})

test("computeCompoundKey returns null when observation is missing", async () => {
  const supabase = makeMockSupabase(null, null)
  const key = await computeCompoundKey(supabase, "00000000-0000-0000-0000-000000000003")
  assert.equal(key, null)
})

// ---------------------------------------------------------------------------
// compoundKeyMatchesErrorCode — segment-anchored drill-down match
// ---------------------------------------------------------------------------

test("compoundKeyMatchesErrorCode anchors on pipe delimiters", () => {
  // Middle position: title:H|err:CODE|frame:FH
  assert.ok(compoundKeyMatchesErrorCode("title:ab12|err:ENOENT|frame:cd34", "ENOENT"))
  // Suffix position (no frame): title:H|err:CODE
  assert.ok(compoundKeyMatchesErrorCode("title:ab12|err:ENOENT", "ENOENT"))
})

test("compoundKeyMatchesErrorCode rejects prefix false-positives (err:EAC does NOT match EACCES)", () => {
  // This is the review-surfaced bug the helper exists to prevent.
  assert.equal(compoundKeyMatchesErrorCode("title:ab12|err:EACCES|frame:cd34", "EAC"), false)
  assert.equal(compoundKeyMatchesErrorCode("title:ab12|err:EACCES", "EAC"), false)
})

test("compoundKeyMatchesErrorCode rejects empty inputs and non-matching codes", () => {
  assert.equal(compoundKeyMatchesErrorCode(null, "ENOENT"), false)
  assert.equal(compoundKeyMatchesErrorCode("", "ENOENT"), false)
  assert.equal(compoundKeyMatchesErrorCode("title:ab12|err:ENOENT", ""), false)
  assert.equal(compoundKeyMatchesErrorCode("title:ab12|err:ENOENT", "EACCES"), false)
  // Title-only key has no err: segment.
  assert.equal(compoundKeyMatchesErrorCode("title:ab12", "ENOENT"), false)
  // Frame-only key (err absent) must not match.
  assert.equal(compoundKeyMatchesErrorCode("title:ab12|frame:cd34", "ENOENT"), false)
})

test("computeCompoundKey matches buildCompoundClusterKey for the same inputs (one source of truth)", async () => {
  const title = "Codex hangs in CI"
  const fingerprint = extractBugFingerprint({
    title,
    content: 'File "/src/agent/loop.py", line 42, in step\nEACCES: permission denied',
  })
  const supabase = makeMockSupabase(
    { title },
    {
      error_code: fingerprint.error_code,
      top_stack_frame: fingerprint.top_stack_frame,
      top_stack_frame_hash: fingerprint.top_stack_frame_hash,
      cli_version: fingerprint.cli_version,
      os: fingerprint.os,
      shell: fingerprint.shell,
      editor: fingerprint.editor,
      model_id: fingerprint.model_id,
      repro_markers: fingerprint.repro_markers,
      keyword_presence: fingerprint.keyword_presence,
    },
  )

  const computed = await computeCompoundKey(supabase, "00000000-0000-0000-0000-000000000004")
  const built = buildCompoundClusterKey(title, fingerprint)
  assert.equal(computed, built)
})
