// Contract tests for the cluster-label producer/consumer floor.
//
// The "no Unnamed family" guarantee depends on a producer/consumer
// invariant: every cluster the producer writes has confidence >=
// MIN_DISPLAYABLE_LABEL_CONFIDENCE, and every consumer renders only
// when confidence is also >= MIN_DISPLAYABLE_LABEL_CONFIDENCE. The
// constant is exported from lib/storage/cluster-label-fallback.ts and
// is the single source of truth.
//
// These tests fail-fast if:
//   1. The producer floor drifts from the published constant.
//   2. The constant changes value silently (a literal `0.4` regression).
//   3. The LABEL_MODEL taxonomy gains an entry that
//      composeDeterministicLabel cannot emit (or vice versa).
//   4. A UI file regresses to a hardcoded `0.4` literal instead of
//      importing MIN_DISPLAYABLE_LABEL_CONFIDENCE.
//
// (3) is what guarantees `clusters.label_model` analytics aren't
// quietly invalidated by a mistyped string at a write site, and (4)
// is what keeps the producer/consumer contract self-enforcing rather
// than convention-only.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  LABEL_MODEL,
  MIN_DISPLAYABLE_LABEL_CONFIDENCE,
  composeDeterministicLabel,
  type DeterministicLabelModel,
} from "../lib/storage/cluster-label-fallback.ts"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("MIN_DISPLAYABLE_LABEL_CONFIDENCE is pinned at 0.4", () => {
  // The exact value matters: the rung confidences in the deterministic
  // ladder are calibrated against this floor. Bumping it without also
  // bumping the rungs would undisplay the lowest rung; bumping the
  // rungs without this would let stub labels through. Either move
  // requires a coordinated review, hence the literal pin.
  assert.equal(MIN_DISPLAYABLE_LABEL_CONFIDENCE, 0.4)
})

test("every deterministic rung produces confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE", () => {
  const rungs = [
    { topicSlugs: ["bug"], errorCodes: ["ENOENT"], titles: ["t"] },
    { topicSlugs: ["bug"], errorCodes: [null], titles: ["t"] },
    { topicSlugs: [null], errorCodes: ["ENOENT"], titles: ["t"] },
    { topicSlugs: [null], errorCodes: [null], titles: ["t"] },
  ]
  for (const args of rungs) {
    const result = composeDeterministicLabel(args)
    assert.ok(
      result.confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE,
      `Rung produced confidence ${result.confidence} below the displayable floor`,
    )
  }
})

test("LABEL_MODEL covers exactly the rungs composeDeterministicLabel can emit", () => {
  // Walk the same four rungs as above and collect the actual emitted
  // model strings, then compare to the deterministic subset of the
  // LABEL_MODEL taxonomy. Any divergence (a rung that emits a model
  // name not in the taxonomy, or a taxonomy entry no rung emits)
  // means the audit catalogue and the writer fell out of sync.
  const emitted = new Set<DeterministicLabelModel>()
  emitted.add(
    composeDeterministicLabel({
      topicSlugs: ["bug"],
      errorCodes: ["ENOENT"],
      titles: ["t"],
    }).model,
  )
  emitted.add(
    composeDeterministicLabel({
      topicSlugs: ["bug"],
      errorCodes: [null],
      titles: ["t"],
    }).model,
  )
  emitted.add(
    composeDeterministicLabel({
      topicSlugs: [null],
      errorCodes: ["ENOENT"],
      titles: ["t"],
    }).model,
  )
  emitted.add(
    composeDeterministicLabel({
      topicSlugs: [null],
      errorCodes: [null],
      titles: ["t"],
    }).model,
  )

  const taxonomyDeterministic = new Set<DeterministicLabelModel>([
    LABEL_MODEL.DETERMINISTIC_TOPIC_AND_ERROR,
    LABEL_MODEL.DETERMINISTIC_TOPIC,
    LABEL_MODEL.DETERMINISTIC_ERROR,
    LABEL_MODEL.DETERMINISTIC_TITLE,
  ])

  assert.deepEqual(
    [...emitted].sort(),
    [...taxonomyDeterministic].sort(),
    "Deterministic taxonomy and emitted rung models diverged",
  )
})

test("LABEL_MODEL keeps the legacy v1 stub tag for the backfill targeter", () => {
  // The backfill in scripts/021_backfill_deterministic_labels.ts uses
  // this constant to find pre-v2 rows that still carry the old
  // `fallback:title` model string. Removing it would silently drop
  // pre-v2 rows from the upgrade query.
  assert.equal(LABEL_MODEL.LEGACY_FALLBACK_TITLE, "fallback:title")
})

test("LABEL_MODEL.OPENAI_PREFIX matches the prefix the writer composes", () => {
  assert.equal(LABEL_MODEL.OPENAI_PREFIX, "openai:")
})

// Static guard: no consumer file may regress to ANY hardcoded numeric
// literal compared against `label_confidence`. The previous version of
// this guard pinned only `0.4`, which let a `0.6` literal in
// components/dashboard/family-card.tsx silently suppress every
// deterministic fallback label. The check now matches any numeric
// threshold (and any comparison operator) so the next drift fails the
// suite regardless of which value gets inlined.
test("no UI consumer hardcodes a numeric threshold next to label_confidence", () => {
  const dirs = ["app", "components/dashboard"]
  const offenders: Array<{ file: string; line: number; text: string }> = []
  // Matches `label_confidence <op> <number>` and the symmetric
  // `<number> <op> label_confidence` (e.g. `0.6 <= label_confidence`).
  const literalLhs = /label_confidence[^\n]*?(?:>=|<=|>|<|===|!==|==|!=)\s*(?:-?\d+(?:\.\d+)?|\.\d+)/
  const literalRhs = /(?:-?\d+(?:\.\d+)?|\.\d+)\s*(?:>=|<=|>|<|===|!==|==|!=)[^\n]*?label_confidence/

  function walk(dir: string): string[] {
    const out: string[] = []
    const abs = path.join(REPO_ROOT, dir)
    for (const name of readdirSync(abs)) {
      const full = path.join(abs, name)
      const rel = path.join(dir, name)
      const s = statSync(full)
      if (s.isDirectory()) out.push(...walk(rel))
      else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
    }
    return out
  }

  for (const d of dirs) {
    for (const rel of walk(d)) {
      const text = readFileSync(path.join(REPO_ROOT, rel), "utf8")
      const lines = text.split("\n")
      lines.forEach((line, idx) => {
        if (literalLhs.test(line) || literalRhs.test(line)) {
          offenders.push({ file: rel, line: idx + 1, text: line.trim() })
        }
      })
    }
  }

  assert.equal(
    offenders.length,
    0,
    `Hardcoded numeric threshold against label_confidence found:\n${offenders
      .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
      .join("\n")}\n` +
      `Import MIN_DISPLAYABLE_LABEL_CONFIDENCE from @/lib/storage/cluster-label-fallback instead.`,
  )
})
