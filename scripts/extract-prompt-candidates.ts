/**
 * Pull candidate observation report-text rows from Supabase to seed the
 * classifier prompt's few-shot examples block.
 *
 * Read-only. Uses the service-role admin client.
 *
 * Why this script exists
 *   The new classifier prompt (lib/classification/prompt.ts) wants real
 *   anchored examples for the most-confused category pairs. The existing
 *   `classifications.category` labels were produced by the OLD prompt
 *   (no definitions), so we cannot trust them as ground truth. Instead,
 *   we pull RAW report_text by keyword and triage candidates by hand
 *   with the new definitions in hand.
 *
 * Output
 *   Writes JSON to scripts/tmp/prompt-candidates-YYYYMMDD.json (gitignored).
 *   Each candidate carries observation_id, title, truncated content,
 *   the existing (legacy) classification + confidence as a hint, and
 *   the keyword bucket that surfaced it.
 *
 * Usage
 *   node --experimental-strip-types scripts/extract-prompt-candidates.ts
 *   node --experimental-strip-types scripts/extract-prompt-candidates.ts --per-bucket=15
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createAdminClient } from "../lib/supabase/admin.ts"

// Each bucket maps a confusable category pair (or a hard-rule category
// like autonomy_safety_violation) to the keywords whose presence in
// title or content tends to surface candidates for it. Keyword sets are
// intentionally broad — over-pull on read, narrow by hand later.
const BUCKETS: Array<{
  name: string
  pair: string
  keywords: string[]
}> = [
  {
    name: "context_overflow_vs_retrieval_mismatch",
    pair: "incomplete_context_overflow vs retrieval_context_mismatch",
    keywords: [
      "context window", "truncated", "ran out of context",
      "attached files", "wrong file", "retrieved", "rag",
      "didn't read", "did not read", "missed the file",
      "lost track of", "forgot the", "out of tokens",
    ],
  },
  {
    name: "tool_failure_vs_env_vs_plugin",
    pair: "tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure",
    keywords: [
      "command not found", "ENOENT", "exit code", "shell",
      "MCP", "extension", "plugin", "vscode", "jetbrains",
      "cursor", "gh:", "git push", "npm err", "node version",
      "python version", "permission denied", "rate limit",
      "timed out", "timeout calling",
    ],
  },
  {
    name: "hallucination_vs_misread_intent",
    pair: "hallucinated_code vs user_intent_misinterpretation",
    keywords: [
      "does not exist", "doesn't exist", "made up", "invented",
      "fabricated", "no such function", "no such file",
      "wrong function", "not what i asked", "not what I asked",
      "ignored my", "ignored the", "misunderstood", "wrong scope",
      "different problem",
    ],
  },
  {
    name: "code_bug_vs_structural_oversight",
    pair: "code_generation_bug vs structural_dependency_oversight",
    keywords: [
      "type error", "typeerror", "undefined", "did not update",
      "didn't update", "interface", "caller", "call site",
      "broke the build", "broke build", "callers fail",
      "missing import", "circular", "schema mismatch",
    ],
  },
  {
    name: "autonomy_safety_violation",
    pair: "autonomy_safety_violation",
    keywords: [
      "rm -rf", "force push", "force-push", "leaked",
      "secret", "api key", "credentials", "deleted my",
      "wiped", "dropped table", "data loss", "billing",
      "production database",
    ],
  },
]

interface ParsedArgs {
  perBucket: number
  reportPath?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { perBucket: 10 }
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--per-bucket=")) {
      const n = Number.parseInt(arg.slice("--per-bucket=".length), 10)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --per-bucket: ${arg}`)
      out.perBucket = n
    } else if (arg.startsWith("--report=")) {
      out.reportPath = arg.slice("--report=".length)
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node --experimental-strip-types scripts/extract-prompt-candidates.ts [--per-bucket=N] [--report=PATH]\n" +
          "       Pulls observation candidates by keyword, writes JSON for prompt few-shot triage.",
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}

interface ObservationRow {
  id: string
  title: string
  content: string | null
  url: string | null
  captured_at: string
}

interface ClassificationHint {
  observation_id: string
  category: string
  subcategory: string
  confidence: number
  summary: string
  alternate_categories: string[] | null
  needs_human_review: boolean
}

interface Candidate {
  bucket: string
  pair: string
  matched_keyword: string
  observation_id: string
  url: string | null
  captured_at: string
  title: string
  content_excerpt: string
  legacy_hint: ClassificationHint | null
}

function buildOrFilter(keyword: string): string {
  // Supabase .or() takes a comma-separated PostgREST filter string. Escape
  // commas in the keyword (none of ours contain them but defend anyway).
  const safe = keyword.replace(/,/g, " ")
  return `title.ilike.%${safe}%,content.ilike.%${safe}%`
}

async function fetchByKeyword(
  admin: ReturnType<typeof createAdminClient>,
  keyword: string,
  limit: number,
): Promise<ObservationRow[]> {
  const { data, error } = await admin
    .from("observations")
    .select("id,title,content,url,captured_at")
    .or(buildOrFilter(keyword))
    .order("captured_at", { ascending: false })
    .limit(limit)
  if (error) throw new Error(`[observations] keyword "${keyword}" failed: ${error.message}`)
  return (data ?? []) as ObservationRow[]
}

async function fetchClassificationHints(
  admin: ReturnType<typeof createAdminClient>,
  observationIds: string[],
): Promise<Map<string, ClassificationHint>> {
  if (observationIds.length === 0) return new Map()
  const { data, error } = await admin
    .from("classifications")
    .select(
      "observation_id,category,subcategory,confidence,summary,alternate_categories,needs_human_review,created_at",
    )
    .in("observation_id", observationIds)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`[classifications] hint fetch failed: ${error.message}`)

  // For each observation, keep the most recent classification only.
  const latest = new Map<string, ClassificationHint>()
  for (const row of (data ?? []) as Array<ClassificationHint & { created_at: string }>) {
    if (!latest.has(row.observation_id)) {
      const { created_at: _ignored, ...hint } = row
      latest.set(row.observation_id, hint)
    }
  }
  return latest
}

function excerpt(content: string | null, max = 600): string {
  if (!content) return ""
  const trimmed = content.trim().replace(/\s+/g, " ")
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

async function run() {
  const args = parseArgs(process.argv)
  const admin = createAdminClient()

  const allCandidates: Candidate[] = []
  const seenObservationIds = new Set<string>()

  for (const bucket of BUCKETS) {
    let bucketCount = 0
    for (const keyword of bucket.keywords) {
      if (bucketCount >= args.perBucket) break
      const remaining = args.perBucket - bucketCount
      const rows = await fetchByKeyword(admin, keyword, remaining)
      for (const row of rows) {
        if (seenObservationIds.has(row.id)) continue
        seenObservationIds.add(row.id)
        allCandidates.push({
          bucket: bucket.name,
          pair: bucket.pair,
          matched_keyword: keyword,
          observation_id: row.id,
          url: row.url,
          captured_at: row.captured_at,
          title: row.title,
          content_excerpt: excerpt(row.content),
          legacy_hint: null,
        })
        bucketCount += 1
        if (bucketCount >= args.perBucket) break
      }
    }
  }

  const hints = await fetchClassificationHints(
    admin,
    allCandidates.map((c) => c.observation_id),
  )
  for (const candidate of allCandidates) {
    candidate.legacy_hint = hints.get(candidate.observation_id) ?? null
  }

  const grouped = BUCKETS.map((b) => ({
    bucket: b.name,
    pair: b.pair,
    candidates: allCandidates.filter((c) => c.bucket === b.name),
  }))

  const summary = {
    generated_at: new Date().toISOString(),
    per_bucket_target: args.perBucket,
    total_candidates: allCandidates.length,
    buckets: grouped,
    triage_instructions: [
      "1. For each bucket, pick the ONE candidate that best illustrates the pair's tiebreaker.",
      "2. Redact: replace names with <name>, file paths with <repo>/path/to/file.ext, UUIDs with <uuid>, secrets with <token>, customer-specific URLs with the bare domain.",
      "3. Decide the v2 category + subcategory using lib/classification/taxonomy.ts CATEGORY_DEFINITIONS — do NOT defer to legacy_hint.category, that label came from the old prompt.",
      "4. Paste the chosen candidates back to the assistant for embedding in lib/classification/prompt.ts.",
    ],
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const tmpDir = path.join(here, "tmp")
  const stamp = summary.generated_at.slice(0, 10).replace(/-/g, "")
  const reportPath =
    args.reportPath ?? path.join(tmpDir, `prompt-candidates-${stamp}.json`)
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")

  console.log(`Wrote ${allCandidates.length} candidates across ${BUCKETS.length} buckets.`)
  for (const g of grouped) {
    console.log(`  ${g.bucket.padEnd(40)} ${g.candidates.length} candidates`)
  }
  console.log(`\nReport: ${reportPath}`)
  console.log("\nNext: paste the report contents back to the assistant for triage.")
}

run().catch((err) => {
  console.error("[extract-prompt-candidates] failed:", err)
  process.exit(1)
})
