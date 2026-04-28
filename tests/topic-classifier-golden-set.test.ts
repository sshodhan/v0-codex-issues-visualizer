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

// v5 structural invariants — guard the architectural decisions that drove
// the refactor so a future "let's collapse title and body again" PR fails.
test("topic-classifier v5: identical phrase has 4× more weight in the title than in the body", () => {
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

test("topic-classifier v5: [BUG] template prefix is stripped before scoring", () => {
  const withPrefix = categorizeIssue("[BUG] Claude hallucinates imports", "", CATEGORIES)
  const noPrefix = categorizeIssue("Claude hallucinates imports", "", CATEGORIES)
  assert.ok(withPrefix && noPrefix)
  assert.equal(
    withPrefix!.slug,
    noPrefix!.slug,
    "template prefix must not change classification",
  )
})

test("topic-classifier v5: global threshold=2 — model-quality classifies when body score meets threshold", () => {
  // "wrong file" alone in body has pattern_weight 3 in CATEGORY_PATTERNS,
  // no title multiplier. Score 3 >= global threshold 2, so model-quality wins.
  // Per-slug threshold overrides are intentionally empty in v5 — threshold
  // tuning waits for backfill evidence.
  const atThreshold = categorizeIssue("", "wrong file in the diff", CATEGORIES)
  assert.equal(atThreshold?.slug, "model-quality")
})

test("topic-classifier v5: evidence object carries matched phrases, scores, margin, runner-up", () => {
  const r = categorizeIssue(
    "Claude hallucinates imports",
    "the model also enters a loop and never stops",
    CATEGORIES,
  )
  assert.ok(r)
  const ev = r!.evidence
  assert.equal(ev.algorithm_version, "v6")
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

test("topic-classifier v5: returns Other (with evidence) when no slug clears its threshold", () => {
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

// Type-level reachability: ensures TopicResult is exported and confidenceProxy is present.
test("topic-classifier v5: TopicResult shape is exported and well-formed", () => {
  const r: TopicResult | null = categorizeIssue("test", "", CATEGORIES)
  assert.ok(
    r === null ||
      (typeof r.categoryId === "string" &&
        typeof r.slug === "string" &&
        typeof r.confidenceProxy === "number"),
  )
})
