/**
 * N-6 one-shot re-score migration draft (PR #13 follow-up)
 *
 * Why this exists:
 * - PR #13 changed sentiment semantics by removing bug-topic nouns from the
 *   polarity lexicon in `analyzeSentiment`.
 * - Pre-PR-#13 rows in `issues` can therefore have inflated `sentiment` and
 *   `impact_score` values vs post-PR-#13 rows for equivalent text.
 * - Backlog reference: docs/BUGS.md (N-6, still-open until production apply).
 *
 * Safe order of operations:
 * 1) Run the SQL pre-flight backup in scripts/006_rescore_impact_after_pr13.sql.
 * 2) Run this script in dry-run mode and inspect console + JSON report.
 * 3) Run a staged apply with --limit=1000 --apply on staging.
 * 4) Run full --apply in production (with RESCORE_CONFIRM=yes).
 *
 * Runtime estimate (~50k rows):
 * - With batch size 500: ~100 read pages.
 * - Sentiment + impact recalculation is in-process and lightweight (regex/token
 *   work), typically much faster than network I/O.
 * - Most wall time is expected from DB reads/writes; rough estimate is a few
 *   minutes for dry-run, longer for full apply depending on update volume.
 *
 * Execute with Node + TS stripping:
 *   node --experimental-strip-types scripts/006_rescore_impact_after_pr13.ts
 *   node --experimental-strip-types scripts/006_rescore_impact_after_pr13.ts --dry-run --limit=1000
 *   RESCORE_CONFIRM=yes node --experimental-strip-types scripts/006_rescore_impact_after_pr13.ts --apply
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { analyzeSentiment, calculateImpactScore } from "../lib/scrapers/shared.ts"
import { createAdminClient } from "../lib/supabase/admin.ts"

type Sentiment = "positive" | "negative" | "neutral"

type IssueRow = {
  id: string
  title: string
  content: string | null
  sentiment: Sentiment | null
  sentiment_score: number | string | null
  impact_score: number | null
  upvotes: number | null
  comments_count: number | null
}

type UpdatedRow = {
  id: string
  old: {
    sentiment: Sentiment | null
    sentiment_score: number
    impact_score: number
  }
  next: {
    sentiment: Sentiment
    sentiment_score: number
    impact_score: number
  }
}

type ParsedArgs = {
  dryRun: boolean
  apply: boolean
  limit?: number
}

type Summary = {
  generatedAt: string
  mode: "dry-run" | "apply"
  limit: number | null
  batchSize: number
  totals: {
    scanned: number
    wouldUpdate: number
    updated: number
    unchanged: number
  }
  sentimentTransitions: Record<string, number>
  impactDeltaDistribution: Record<string, number>
  categoryCounts: {
    sentimentChanged: number
    sentimentScoreChanged: number
    impactChanged: number
    anyChanged: number
  }
  examples: {
    sentimentChanged: UpdatedRow[]
    sentimentScoreChanged: UpdatedRow[]
    impactChanged: UpdatedRow[]
  }
}

const BATCH_SIZE = 500
const EXAMPLE_LIMIT = 20

function parseArgs(argv: string[]): ParsedArgs {
  let apply = false
  let dryRun = true
  let limit: number | undefined

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true
      dryRun = false
      continue
    }
    if (arg === "--dry-run") {
      dryRun = true
      apply = false
      continue
    }
    if (arg.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length)
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: ${raw}`)
      }
      limit = parsed
      continue
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit()
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (apply && process.env.RESCORE_CONFIRM !== "yes") {
    throw new Error(
      "Refusing --apply without RESCORE_CONFIRM=yes. Use dry-run or set RESCORE_CONFIRM=yes intentionally."
    )
  }

  return { apply, dryRun, limit }
}

function printHelpAndExit(): never {
  console.log(`Usage:
  node --experimental-strip-types scripts/006_rescore_impact_after_pr13.ts [--dry-run] [--limit=N]
  RESCORE_CONFIRM=yes node --experimental-strip-types scripts/006_rescore_impact_after_pr13.ts --apply [--limit=N]

Modes:
  --dry-run  Default. No writes; prints summary and writes JSON report.
  --apply    Performs updates. Requires RESCORE_CONFIRM=yes.

Options:
  --limit=N  Process first N rows only (ordered by id).
`)
  process.exit(0)
}

function toNumericScore(value: number | string | null): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function pushExample(bucket: UpdatedRow[], row: UpdatedRow) {
  if (bucket.length < EXAMPLE_LIMIT) bucket.push(row)
}

function transitionKey(from: Sentiment | null, to: Sentiment): string {
  return `${from ?? "null"}->${to}`
}

function deltaKey(delta: number): string {
  if (delta > 0) return `+${delta}`
  return String(delta)
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const supabase = createAdminClient()

  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry-run",
    limit: args.limit ?? null,
    batchSize: BATCH_SIZE,
    totals: { scanned: 0, wouldUpdate: 0, updated: 0, unchanged: 0 },
    sentimentTransitions: {},
    impactDeltaDistribution: {},
    categoryCounts: {
      sentimentChanged: 0,
      sentimentScoreChanged: 0,
      impactChanged: 0,
      anyChanged: 0,
    },
    examples: {
      sentimentChanged: [],
      sentimentScoreChanged: [],
      impactChanged: [],
    },
  }

  let lastSeenId: string | null = null

  while (true) {
    const remaining = args.limit ? args.limit - summary.totals.scanned : BATCH_SIZE
    if (remaining <= 0) break
    const batchLimit = Math.min(BATCH_SIZE, remaining)

    let query = supabase
      .from("issues")
      .select("id,title,content,sentiment,sentiment_score,impact_score,upvotes,comments_count")
      .order("id", { ascending: true })
      .limit(batchLimit)

    if (lastSeenId) {
      query = query.gt("id", lastSeenId)
    }

    const { data, error } = await query
    if (error) throw new Error(`Failed fetching issues batch: ${error.message}`)

    const rows = (data ?? []) as IssueRow[]
    if (rows.length === 0) break

    for (const row of rows) {
      summary.totals.scanned += 1
      lastSeenId = row.id

      const text = `${row.title} ${row.content ?? ""}`.trim()
      const analyzed = analyzeSentiment(text)
      const newSentiment = analyzed.sentiment
      const newSentimentScore = Number(analyzed.score.toFixed(2))
      const newImpactScore = calculateImpactScore(
        row.upvotes ?? 0,
        row.comments_count ?? 0,
        newSentiment
      )

      const prevSentimentScore = Number(toNumericScore(row.sentiment_score).toFixed(2))
      const prevImpact = row.impact_score ?? 1

      const sentimentChanged = row.sentiment !== newSentiment
      const sentimentScoreChanged = prevSentimentScore !== newSentimentScore
      const impactChanged = prevImpact !== newImpactScore
      const anyChanged = sentimentChanged || sentimentScoreChanged || impactChanged

      if (!anyChanged) {
        summary.totals.unchanged += 1
        continue
      }

      summary.totals.wouldUpdate += 1
      summary.categoryCounts.anyChanged += 1
      if (sentimentChanged) summary.categoryCounts.sentimentChanged += 1
      if (sentimentScoreChanged) summary.categoryCounts.sentimentScoreChanged += 1
      if (impactChanged) summary.categoryCounts.impactChanged += 1

      const transition = transitionKey(row.sentiment, newSentiment)
      summary.sentimentTransitions[transition] = (summary.sentimentTransitions[transition] ?? 0) + 1

      const impactDelta = newImpactScore - prevImpact
      const impactDeltaBucket = deltaKey(impactDelta)
      summary.impactDeltaDistribution[impactDeltaBucket] =
        (summary.impactDeltaDistribution[impactDeltaBucket] ?? 0) + 1

      const record: UpdatedRow = {
        id: row.id,
        old: {
          sentiment: row.sentiment,
          sentiment_score: prevSentimentScore,
          impact_score: prevImpact,
        },
        next: {
          sentiment: newSentiment,
          sentiment_score: newSentimentScore,
          impact_score: newImpactScore,
        },
      }

      if (sentimentChanged) pushExample(summary.examples.sentimentChanged, record)
      if (sentimentScoreChanged) pushExample(summary.examples.sentimentScoreChanged, record)
      if (impactChanged) pushExample(summary.examples.impactChanged, record)

      if (args.apply) {
        const { error: updateError } = await supabase
          .from("issues")
          .update({
            sentiment: newSentiment,
            sentiment_score: newSentimentScore,
            impact_score: newImpactScore,
          })
          .eq("id", row.id)

        if (updateError) {
          throw new Error(`Failed updating issue ${row.id}: ${updateError.message}`)
        }

        summary.totals.updated += 1
      }
    }

    if (rows.length < batchLimit) break
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const tmpDir = path.join(__dirname, "tmp")
  await mkdir(tmpDir, { recursive: true })

  const reportPath = path.join(tmpDir, `rescore-${dateStamp}.json`)
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")

  console.log("=== N-6 re-score summary ===")
  console.log(`Mode: ${summary.mode}`)
  console.log(`Rows scanned: ${summary.totals.scanned}`)
  console.log(`Rows unchanged: ${summary.totals.unchanged}`)
  console.log(`Rows needing update: ${summary.totals.wouldUpdate}`)
  if (args.apply) {
    console.log(`Rows updated: ${summary.totals.updated}`)
  } else {
    console.log("Rows updated: 0 (dry-run)")
  }

  console.log("\nSentiment transitions:")
  for (const [key, value] of Object.entries(summary.sentimentTransitions).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    console.log(`  ${key}: ${value}`)
  }

  console.log("\nImpact delta distribution:")
  for (const [key, value] of Object.entries(summary.impactDeltaDistribution).sort(([a], [b]) =>
    Number(a) - Number(b)
  )) {
    console.log(`  ${key}: ${value}`)
  }

  console.log("\nExamples (first 20 per category):")
  console.log(`  sentimentChanged: ${summary.examples.sentimentChanged.length}`)
  console.log(`  sentimentScoreChanged: ${summary.examples.sentimentScoreChanged.length}`)
  console.log(`  impactChanged: ${summary.examples.impactChanged.length}`)

  console.log(`\nReport written: ${reportPath}`)
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`N-6 re-score script failed: ${message}`)
  process.exit(1)
})
