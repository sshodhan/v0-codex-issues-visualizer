#!/usr/bin/env -S node --experimental-strip-types
//
// Topic classifier evaluation harness.
//
// Loads tests/fixtures/topic-golden-set.jsonl, runs categorizeIssue on each
// row, and prints precision / recall / F1 per slug plus overall accuracy.
// No DB needed — meant to run in a few hundred milliseconds so phrase or
// scoring tweaks can be evaluated locally before opening a PR.
//
// Usage:
//   npx tsx scripts/eval-topic-patterns.ts
//   npx tsx scripts/eval-topic-patterns.ts --jsonl path/to/other.jsonl
//   npx tsx scripts/eval-topic-patterns.ts --verbose      # prints per-row hits
//
// Adding to the golden set: append one JSON object per line, with keys
// `title`, `body`, `expected`. Misclassified production posts surfaced via
// admin diagnostic SQL are the highest-signal additions.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { categorizeIssue } from "../lib/scrapers/shared.ts"
import type { Category } from "../lib/types.ts"

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

function parseArgs(argv: string[]): { jsonl: string; verbose: boolean } {
  let jsonl = resolve(process.cwd(), "tests/fixtures/topic-golden-set.jsonl")
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--jsonl" && argv[i + 1]) {
      jsonl = resolve(process.cwd(), argv[i + 1])
      i++
    } else if (argv[i] === "--verbose" || argv[i] === "-v") {
      verbose = true
    }
  }
  return { jsonl, verbose }
}

function loadGolden(path: string): GoldenRow[] {
  const raw = readFileSync(path, "utf8")
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GoldenRow)
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function main() {
  const { jsonl, verbose } = parseArgs(process.argv.slice(2))
  const rows = loadGolden(jsonl)
  console.log(`Loaded ${rows.length} rows from ${jsonl}\n`)

  // Per-slug counters — TP, FP, FN — for precision/recall/F1.
  const slugs = Array.from(new Set([
    ...CATEGORIES.map((c) => c.slug),
    ...rows.map((r) => r.expected),
  ]))
  const tp: Record<string, number> = {}
  const fp: Record<string, number> = {}
  const fn: Record<string, number> = {}
  for (const s of slugs) { tp[s] = 0; fp[s] = 0; fn[s] = 0 }

  let correct = 0
  const misses: Array<{ row: GoldenRow; got: string | null; evidence: unknown; runnerUpMatchesExpected: boolean }> = []
  // All rows with their margin, regardless of correctness — used for the
  // low-margin diagnostic. Ties / sub-threshold rows have margin 0.
  const allRows: Array<{ row: GoldenRow; got: string | null; margin: number }> = []

  for (const row of rows) {
    const result = categorizeIssue(row.title, row.body, CATEGORIES)
    const got = result?.slug ?? null
    const margin = result?.evidence.scoring.margin ?? 0
    allRows.push({ row, got, margin })

    if (got === row.expected) {
      correct++
      tp[row.expected]++
    } else {
      if (got) fp[got]++
      fn[row.expected]++
      const runnerUpMatchesExpected =
        result?.evidence.scoring.runner_up === row.expected
      misses.push({ row, got, evidence: result?.evidence ?? null, runnerUpMatchesExpected })
    }
  }

  // Print per-slug precision / recall / F1 sorted by support (descending).
  const support: Record<string, number> = {}
  for (const r of rows) support[r.expected] = (support[r.expected] ?? 0) + 1

  const ordered = slugs
    .filter((s) => (support[s] ?? 0) > 0 || tp[s] + fp[s] > 0)
    .sort((a, b) => (support[b] ?? 0) - (support[a] ?? 0))

  console.log(
    `${pad("slug", 20)}${pad("support", 10)}${pad("precision", 12)}${pad("recall", 10)}${pad("F1", 8)}`,
  )
  console.log(
    `${pad("----", 20)}${pad("-------", 10)}${pad("---------", 12)}${pad("------", 10)}${pad("--", 8)}`,
  )
  for (const s of ordered) {
    const p = tp[s] + fp[s] > 0 ? tp[s] / (tp[s] + fp[s]) : 0
    const r = tp[s] + fn[s] > 0 ? tp[s] / (tp[s] + fn[s]) : 0
    const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0
    console.log(
      `${pad(s, 20)}${pad(String(support[s] ?? 0), 10)}${pad(pct(p), 12)}${pad(pct(r), 10)}${pad(pct(f1), 8)}`,
    )
  }

  console.log(`\noverall accuracy: ${pct(correct / rows.length)} (${correct}/${rows.length})`)

  if (misses.length > 0) {
    console.log(`\n--- ${misses.length} misclassified row(s) ---`)
    for (const m of misses) {
      const runnerUpFlag = m.runnerUpMatchesExpected ? " [runner_up=expected]" : ""
      console.log(
        `  expected=${m.row.expected}  got=${m.got ?? "null"}${runnerUpFlag}  title="${m.row.title.slice(0, 80)}"`,
      )
      if (verbose) {
        console.log(`    evidence: ${JSON.stringify(m.evidence)}`)
      }
    }
  }

  // v6 diagnostic: top 10 lowest-margin rows. A small margin means the
  // winner barely beat the runner-up, so these are the rows most likely
  // to flip on the next phrase tweak — useful as the high-leverage
  // candidates for golden-set additions or targeted phrase weight
  // changes. Sort ascending by margin; ties broken by title for stable
  // output.
  console.log(`\n--- top 10 lowest-margin rows ---`)
  const sortedByMargin = [...allRows].sort(
    (a, b) => a.margin - b.margin || a.row.title.localeCompare(b.row.title),
  )
  for (const r of sortedByMargin.slice(0, 10)) {
    console.log(
      `  margin=${r.margin}  expected=${r.row.expected}  got=${r.got ?? "null"}  title="${r.row.title.slice(0, 80)}"`,
    )
  }

  process.exit(misses.length === 0 ? 0 : 1)
}

main()
