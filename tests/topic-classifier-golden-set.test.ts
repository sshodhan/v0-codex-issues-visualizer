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
  const titleScore = titleHit!.evidence.scores["model-quality"] ?? 0
  const bodyScore = bodyHit!.evidence.scores["model-quality"] ?? 0
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

test("topic-classifier v5: per-slug thresholds — model-quality requires score >= 3", () => {
  // "wrong file" alone in body has weight 3 in CATEGORY_PATTERNS (no title
  // multiplier because we put it in the body). In v5 model-quality requires
  // score >= 3 — exactly at threshold.
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
  assert.ok(Array.isArray(ev.matched_phrases) && ev.matched_phrases.length > 0)
  assert.equal(typeof ev.scores, "object")
  assert.equal(typeof ev.margin, "number")
  assert.equal(typeof ev.threshold, "number")
  // Title hit (hallucinates) must be tagged with "title".
  const titleHits = ev.matched_phrases.filter((m) => m.in === "title")
  assert.ok(titleHits.length >= 1, "expected at least one title-segment match")
})

test("topic-classifier v5: returns Other (with evidence) when no slug clears its threshold", () => {
  const r = categorizeIssue("hello world", "thanks everyone", CATEGORIES)
  assert.equal(r?.slug, "other")
  assert.equal(r?.confidence, 0)
  assert.equal(r?.evidence.matched_phrases.length, 0)
})

// Type-level reachability: ensures TopicResult is exported.
test("topic-classifier v5: TopicResult shape is exported and well-formed", () => {
  const r: TopicResult | null = categorizeIssue("test", "", CATEGORIES)
  assert.ok(r === null || (typeof r.categoryId === "string" && typeof r.slug === "string"))
})
