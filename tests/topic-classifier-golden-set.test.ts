import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import { categorizeIssue, type TopicResult } from "../lib/scrapers/shared.ts"
import type { Category } from "../lib/types.ts"

// Mirrors the seed rows in scripts/002_create_issues_schema_v2.sql plus the
// model-quality slot from scripts/023. categorizeIssue only reads `id` and
// `slug`; the other fields satisfy the Category type.
const CATEGORIES: Category[] = [
  { id: "cat-bug", slug: "bug", name: "Bug", color: "#ef4444", created_at: "" },
  { id: "cat-perf", slug: "performance", name: "Performance", color: "#f97316", created_at: "" },
  { id: "cat-fr", slug: "feature-request", name: "Feature Request", color: "#3b82f6", created_at: "" },
  { id: "cat-docs", slug: "documentation", name: "Documentation", color: "#10b981", created_at: "" },
  { id: "cat-ux", slug: "ux-ui", name: "UX/UI", color: "#8b5cf6", created_at: "" },
  { id: "cat-int", slug: "integration", name: "Integration", color: "#06b6d4", created_at: "" },
  { id: "cat-api", slug: "api", name: "API", color: "#14b8a6", created_at: "" },
  { id: "cat-price", slug: "pricing", name: "Pricing", color: "#eab308", created_at: "" },
  { id: "cat-mq", slug: "model-quality", name: "Model Quality", color: "#a855f7", created_at: "" },
  { id: "cat-sec", slug: "security", name: "Security", color: "#dc2626", created_at: "" },
  { id: "cat-other", slug: "other", name: "Other", color: "#6b7280", created_at: "" },
]

interface GoldenRow {
  title: string
  body: string
  expected: string
}

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(HERE, "fixtures/topic-golden-set.jsonl")

function loadGoldenSet(): GoldenRow[] {
  const raw = readFileSync(FIXTURE_PATH, "utf8")
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GoldenRow)
}

const ROWS = loadGoldenSet()

test("topic-golden-set: fixture loads and is non-empty", () => {
  assert.ok(ROWS.length >= 30, `expected at least 30 rows, got ${ROWS.length}`)
  for (const row of ROWS) {
    assert.equal(typeof row.title, "string")
    assert.equal(typeof row.body, "string")
    assert.equal(typeof row.expected, "string")
  }
})

// Per-row precision lock. Each line in topic-golden-set.jsonl creates an
// independent test so a regression on one row reports the offending text
// directly rather than being hidden inside an aggregate "X / Y passed".
for (const row of ROWS) {
  test(`topic-golden-set: ${row.expected} ← ${row.title.slice(0, 80)}`, () => {
    const result = categorizeIssue(row.title, row.body, CATEGORIES)
    const actualSlug = result?.slug ?? null
    assert.equal(
      actualSlug,
      row.expected,
      `expected ${row.expected}, got ${actualSlug}; evidence=${JSON.stringify(result?.evidence)}`,
    )
  })
}

// Aggregate metric — useful as a one-line health indicator over time.
test("topic-golden-set: overall accuracy >= 90%", () => {
  let correct = 0
  for (const row of ROWS) {
    const result = categorizeIssue(row.title, row.body, CATEGORIES)
    if (result?.slug === row.expected) correct++
  }
  const accuracy = correct / ROWS.length
  assert.ok(
    accuracy >= 0.9,
    `accuracy ${(accuracy * 100).toFixed(1)}% (${correct}/${ROWS.length}) below 90% floor`,
  )
})

// Structural invariants (introduced in v5, asserted on every version) —
// guard the architectural decisions that drove the v5 refactor so a future
// "let's collapse title and body again" PR fails.
test("topic-classifier: identical phrase has 4× more weight in the title than in the body", () => {
  const titleHit = categorizeIssue("hallucinates", "", CATEGORIES)
  const bodyHit = categorizeIssue("", "hallucinates", CATEGORIES)
  assert.ok(titleHit, "title-only run must classify")
  assert.ok(bodyHit, "body-only run must classify")
  const titleScore = titleHit!.evidence.scoring.scores["model-quality"] ?? 0
  const bodyScore = bodyHit!.evidence.scoring.scores["model-quality"] ?? 0
  assert.ok(
    titleScore === bodyScore * 4,
    `expected title 4× body; got title=${titleScore} body=${bodyScore}`,
  )
})

test("topic-classifier: [BUG] template prefix is stripped before scoring", () => {
  const withPrefix = categorizeIssue("[BUG] Claude hallucinates imports", "", CATEGORIES)
  const noPrefix = categorizeIssue("Claude hallucinates imports", "", CATEGORIES)
  assert.ok(withPrefix && noPrefix)
  assert.equal(
    withPrefix!.slug,
    noPrefix!.slug,
    "template prefix must not change classification",
  )
})

test("topic-classifier: global threshold=2 — model-quality classifies when body score meets threshold", () => {
  // "wrong file" alone in body has pattern_weight 3 in CATEGORY_PATTERNS,
  // no title multiplier. Score 3 >= global threshold 2, so model-quality wins.
  // Per-slug threshold overrides are intentionally empty (introduced in v5,
  // still empty in v6) — threshold tuning waits for backfill evidence.
  const atThreshold = categorizeIssue("", "wrong file in the diff", CATEGORIES)
  assert.equal(atThreshold?.slug, "model-quality")
})

test("topic-classifier v7: evidence object carries matched phrases, scores, margin, runner-up", () => {
  const r = categorizeIssue(
    "Claude hallucinates imports",
    "the model also enters a loop and never stops",
    CATEGORIES,
  )
  assert.ok(r)
  const ev = r!.evidence
  assert.equal(ev.algorithm_version, "v7")
  assert.equal(ev.classifier_type, "regex_topic")
  assert.ok(Array.isArray(ev.matched_phrases) && ev.matched_phrases.length > 0)
  assert.equal(typeof ev.scoring.scores, "object")
  assert.equal(typeof ev.scoring.margin, "number")
  assert.equal(typeof ev.scoring.threshold, "number")
  assert.equal(typeof ev.scoring.confidence_proxy, "number")
  // Title hit (hallucinates) must be tagged with location "title".
  const titleHits = ev.matched_phrases.filter((m) => m.location === "title")
  assert.ok(titleHits.length >= 1, "expected at least one title-segment match")
  // Each match must have slug, pattern_weight, effective_weight, raw_hits, weighted_score.
  for (const m of ev.matched_phrases) {
    assert.equal(typeof m.slug, "string")
    assert.equal(typeof m.pattern_weight, "number")
    assert.equal(typeof m.effective_weight, "number")
    assert.equal(typeof m.raw_hits, "number")
    assert.equal(typeof m.weighted_score, "number")
  }
})

test("topic-classifier: returns Other (with evidence) when no slug clears its threshold", () => {
  const r = categorizeIssue("hello world", "thanks everyone", CATEGORIES)
  assert.equal(r?.slug, "other")
  assert.equal(r?.confidenceProxy, 0)
  assert.equal(r?.evidence.matched_phrases.length, 0)
})

test("topic-classifier v6: row 46 — `bypass the approval prompt` wins over ux-ui `approval prompt` with margin >= 4", () => {
  const r = categorizeIssue(
    "Is there a way to bypass the approval prompt on trusted repos?",
    "",
    CATEGORIES,
  )
  assert.equal(r?.slug, "feature-request")
  assert.ok(
    (r?.evidence.scoring.margin ?? 0) >= 4,
    `expected margin >= 4, got ${r?.evidence.scoring.margin}`,
  )
})

// v7 structural invariants — the four mechanism changes shipped in v7.
// Each invariant guards a specific audit-driven decision; a future PR
// that reverts any of them must update or remove the corresponding
// test, making the regression deliberate.

test("topic-classifier v7: BODY_TEMPLATE_HEADER_RE strips `### What subscription do you have?\\nPro` so pricing does NOT win on a bug body", () => {
  // Mirrors the dominant pre-v7 false-positive shape: a Codex GitHub
  // issue-template field saying "Pro" leaked +3 pricing weight on
  // every issue. After stripping, only the actual bug text scores.
  const body = "### What subscription do you have?\nPro\n\nshell argument escaping is broken on the commit path"
  const r = categorizeIssue("Codex still writes literal backslash-n", body, CATEGORIES)
  assert.ok(r, "must classify (template stripping does not blank the row)")
  assert.notEqual(r!.slug, "pricing", `pricing should NOT win; got ${r!.slug}; evidence=${JSON.stringify(r!.evidence)}`)
  // The input flag should record that body-stripping happened.
  assert.equal(r!.evidence.input.template_stripped, true)
})

test("topic-classifier v7: BODY_TEMPLATE_HEADER_RE strips `### What plan are you on?\\nPro plan` so pricing does NOT win on a model-quality body", () => {
  // Covers the `pro plan` / `team plan` / `enterprise plan` leak from
  // the same template family (visible-list screenshots, 2026-04-29).
  const body = "### What plan are you on?\nPro plan\n\nthe model is at capacity for every turn and keeps repeating the same step"
  const r = categorizeIssue("Selected model at capacity", body, CATEGORIES)
  assert.ok(r)
  assert.notEqual(r!.slug, "pricing", `pricing should NOT win; got ${r!.slug}; evidence=${JSON.stringify(r!.evidence)}`)
})

test("topic-classifier v7: prose `### Why is plan caching slow?` heading is NOT stripped — keyword whitelist + answer-line cap protect prose", () => {
  // The `plan` keyword appears in the heading but the answer paragraph
  // exceeds 120 chars, so BODY_TEMPLATE_HEADER_RE must leave it alone.
  // Otherwise legitimate prose with metadata words would be silently
  // erased from scoring.
  const longProse = "Plan caching takes 30 plus seconds on repositories with more than 10000 files because the cache invalidation strategy is too aggressive and re-walks the entire tree on every small change which makes the agent painfully slow"
  const body = `### Why is plan caching slow?\n${longProse}`
  const r = categorizeIssue("plan caching is slow", body, CATEGORIES)
  assert.ok(r)
  // Prose is preserved → "painfully slow" still fires (performance, w4).
  assert.equal(r!.slug, "performance", `expected performance; got ${r!.slug}; evidence=${JSON.stringify(r!.evidence)}`)
})

test("topic-classifier v7: margin-0 abstain — exact-tie scores return slug=other with confidence 0 and preserve tied candidates in evidence", () => {
  // bug `errored` (w3, wholeWord) + performance `slow` (w3, wholeWord)
  // → bug=3, performance=3 at body weight. Both clear default
  // threshold 2; insertion order would have given this row to bug.
  const r = categorizeIssue("", "the build errored and the cli is slow", CATEGORIES)
  assert.ok(r, "must return a result, not null")
  assert.equal(r!.slug, "other", `expected other (margin-0 abstain); got ${r!.slug}; evidence=${JSON.stringify(r!.evidence)}`)
  assert.equal(r!.confidenceProxy, 0)
  assert.equal(r!.evidence.scoring.margin, 0)
  // Audit fields preserve the original tied candidates so phrase
  // refinement can target the actual disagreement.
  assert.equal(r!.evidence.scoring.abstain_reason, "margin_0_tie")
  assert.equal(typeof r!.evidence.scoring.abstained_winner, "string")
  assert.equal(typeof r!.evidence.scoring.abstained_runner_up, "string")
  assert.notEqual(r!.evidence.scoring.abstained_winner, r!.evidence.scoring.abstained_runner_up)
  assert.notEqual(r!.evidence.scoring.runner_up, null)
})

test("topic-classifier v7: bare `subscription` in body no longer triggers pricing", () => {
  // Audit (Q5): 92% of body `subscription` matches were template
  // boilerplate. v7 removes the phrase entirely, so a body containing
  // only `subscription` and no other pricing vocabulary scores 0 for
  // pricing.
  const r = categorizeIssue(
    "Generic title with no scoring words",
    "I have a subscription and the cli does something unexpected here",
    CATEGORIES,
  )
  // Either "other" (no slug clears threshold) or any non-pricing slug
  // (if some other phrase happens to fire) — but never pricing.
  assert.notEqual(r?.slug, "pricing", `pricing should NOT win; got ${r?.slug}; evidence=${JSON.stringify(r?.evidence)}`)
})

// v7 recall guard — pricing threshold = 4 must not regress real pricing
// reports. The PR raises pricing's threshold to keep lone weight-3
// phrases from sole-winning, so a multi-phrase pricing report is the
// case we must lock in.
test("topic-classifier v7: real pricing report clears the new pricing threshold (recall guard)", () => {
  const r = categorizeIssue(
    "Out of credits despite billing details showing usage remaining",
    "quota exceeded and billing details show plenty of remaining usage",
    CATEGORIES,
  )
  assert.ok(r, "must classify")
  assert.equal(r!.slug, "pricing", `expected pricing; got ${r!.slug}; evidence=${JSON.stringify(r!.evidence)}`)
  // Score must clear pricing's per-slug threshold (4), not just the
  // default of 2 — guards against an accidental future override that
  // would silently regress recall.
  const pricingScore = r!.evidence.scoring.scores["pricing"] ?? 0
  assert.ok(
    pricingScore >= 4,
    `pricing score ${pricingScore} must clear threshold=4; evidence=${JSON.stringify(r!.evidence)}`,
  )
  // Threshold field on evidence reflects the pricing-specific override.
  assert.equal(r!.evidence.scoring.threshold, 4)
})

// v7 over-strip guard — `### Environment` is in the metadata-keyword
// whitelist, but only the heading + first short answer line should be
// stripped. Multi-line repro / log dumps under such a heading must
// stay available for scoring so bug signal isn't silently erased.
test("topic-classifier v7: BODY_TEMPLATE_HEADER_RE preserves multi-line repro under `### Environment`", () => {
  const body = [
    "### Environment",
    "- macOS 15.2",
    "- Codex CLI 0.20.5",
    "- Shell: zsh",
    "",
    "### Reproduction steps",
    "1. Run codex on a fresh repo",
    "2. Observe the traceback in the console — typeerror in lib/foo.js",
    "3. The cli panics and exits with status code 1",
  ].join("\n")
  const r = categorizeIssue("CLI panics on startup", body, CATEGORIES)
  assert.ok(r, "must classify")
  // `traceback` (bug w4) and `typeerror` (bug w4) survive in the body
  // because they are not on the single-line answer beneath
  // `### Environment`. Bug must win.
  assert.equal(r!.slug, "bug", `expected bug; got ${r!.slug}; evidence=${JSON.stringify(r!.evidence)}`)
  // Sanity: at least one bug match came from the body, not the title.
  const bodyBugMatches = r!.evidence.matched_phrases.filter(
    (m) => m.location === "body" && m.slug === "bug",
  )
  assert.ok(
    bodyBugMatches.length >= 1,
    `expected ≥1 body-segment bug match; got ${bodyBugMatches.length}; matches=${JSON.stringify(r!.evidence.matched_phrases)}`,
  )
})

// Type-level reachability: ensures TopicResult is exported and confidenceProxy is present.
test("topic-classifier: TopicResult shape is exported and well-formed", () => {
  const r: TopicResult | null = categorizeIssue("test", "", CATEGORIES)
  assert.ok(
    r === null ||
      (typeof r.categoryId === "string" &&
        typeof r.slug === "string" &&
        typeof r.confidenceProxy === "number"),
  )
})
