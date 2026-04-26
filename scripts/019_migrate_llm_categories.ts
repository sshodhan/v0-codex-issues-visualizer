/**
 * Backfill `bug_report_classifications` from the legacy LLM category enum
 * to the robust enum introduced in lib/classification/taxonomy.ts.
 *
 * Usage:
 *   node --experimental-strip-types scripts/019_migrate_llm_categories.ts --dry-run
 *   CATEGORY_MIGRATION_CONFIRM=yes node --experimental-strip-types scripts/019_migrate_llm_categories.ts --apply
 *   CATEGORY_MIGRATION_CONFIRM=yes node --experimental-strip-types scripts/019_migrate_llm_categories.ts --apply --fallback=user_intent_misinterpretation
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createAdminClient } from "../lib/supabase/admin.ts"
import { CATEGORY_ENUM, type IssueCategory } from "../lib/classification/taxonomy.ts"

type LegacyRow = {
  id: string
  category: string
  alternate_categories: string[] | null
  raw_json: Record<string, unknown> | null
}

const LEGACY_TO_ROBUST: Record<string, IssueCategory> = {
  "code-generation-quality": "code_generation_bug",
  hallucination: "hallucinated_code",
  "tool-use-failure": "tool_invocation_error",
  "context-handling": "incomplete_context_overflow",
  "latency-performance": "performance_latency_issue",
  "auth-session": "session_auth_error",
  "cli-ux": "cli_user_experience_bug",
  "install-env": "dependency_environment_failure",
  "cost-quota": "cost_quota_overrun",
  "safety-policy": "autonomy_safety_violation",
  "integration-mcp": "integration_plugin_failure",
}

type ParsedArgs = {
  dryRun: boolean
  apply: boolean
  batchSize: number
  fallback: IssueCategory
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    dryRun: true,
    apply: false,
    batchSize: 500,
    fallback: "user_intent_misinterpretation",
  }
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--apply") {
      args.apply = true
      args.dryRun = false
    } else if (arg.startsWith("--batch-size=")) {
      args.batchSize = Number(arg.split("=")[1] ?? "500")
    } else if (arg.startsWith("--fallback=")) {
      const fallback = arg.split("=")[1] ?? ""
      if ((CATEGORY_ENUM as readonly string[]).includes(fallback)) {
        args.fallback = fallback as IssueCategory
      } else {
        throw new Error(`Invalid --fallback category: ${fallback}`)
      }
    }
  }
  return args
}

function mapCategory(value: string | null | undefined, fallback: IssueCategory): IssueCategory {
  if (!value) return fallback
  if ((CATEGORY_ENUM as readonly string[]).includes(value)) {
    return value as IssueCategory
  }
  return LEGACY_TO_ROBUST[value] ?? fallback
}

async function run() {
  const args = parseArgs(process.argv)
  if (args.apply && process.env.CATEGORY_MIGRATION_CONFIRM !== "yes") {
    console.error("Refusing to --apply without CATEGORY_MIGRATION_CONFIRM=yes.")
    process.exit(2)
  }

  const admin = createAdminClient()
  let lastId: string | null = null
  let scanned = 0
  let updated = 0
  let fallbackCount = 0
  const fallbackSamples = new Map<string, number>()

  while (true) {
    let query = admin
      .from("bug_report_classifications")
      .select("id, category, alternate_categories, raw_json")
      .order("id", { ascending: true })
      .limit(args.batchSize)
    if (lastId) query = query.gt("id", lastId)

    const { data, error } = await query
    if (error) {
      console.error("[category-migration] fetch failed:", error)
      process.exit(1)
    }
    if (!data || data.length === 0) break

    for (const row of data as LegacyRow[]) {
      scanned += 1
      const nextCategory = mapCategory(row.category, args.fallback)
      const nextAlternates = (row.alternate_categories ?? []).map((v) => mapCategory(v, args.fallback))
      const nextRawJson = row.raw_json
        ? { ...row.raw_json, category: nextCategory, alternate_categories: nextAlternates }
        : row.raw_json

      const usedFallbackForPrimary =
        !(CATEGORY_ENUM as readonly string[]).includes(row.category) && !(row.category in LEGACY_TO_ROBUST)
      if (usedFallbackForPrimary) {
        fallbackCount += 1
        fallbackSamples.set(row.category, (fallbackSamples.get(row.category) ?? 0) + 1)
      }

      const categoryChanged = row.category !== nextCategory
      const alternatesChanged = JSON.stringify(row.alternate_categories ?? []) !== JSON.stringify(nextAlternates)
      if (!categoryChanged && !alternatesChanged) continue

      if (args.apply) {
        const { error: updateError } = await admin
          .from("bug_report_classifications")
          .update({
            category: nextCategory,
            alternate_categories: nextAlternates,
            raw_json: nextRawJson,
          })
          .eq("id", row.id)
        if (updateError) {
          console.error("[category-migration] update failed:", row.id, updateError)
          process.exit(1)
        }
      }
      updated += 1
    }

    lastId = data[data.length - 1]?.id ?? null
    if (data.length < args.batchSize) break
  }

  const summary = {
    mode: args.dryRun ? "dry-run" : "apply",
    fallback_category: args.fallback,
    scanned_rows: scanned,
    updated_rows: updated,
    fallback_primary_count: fallbackCount,
    fallback_primary_samples: [...fallbackSamples.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([legacy, count]) => ({ legacy, count })),
  }

  console.log(JSON.stringify(summary, null, 2))

  const here = path.dirname(fileURLToPath(import.meta.url))
  const tmpDir = path.join(here, "tmp")
  await mkdir(tmpDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const outPath = path.join(tmpDir, `llm-category-migration-${stamp}.json`)
  await writeFile(outPath, JSON.stringify(summary, null, 2))
  console.error(`[category-migration] wrote report to ${outPath}`)
}

run().catch((err) => {
  console.error("[category-migration] failed:", err)
  process.exit(1)
})
