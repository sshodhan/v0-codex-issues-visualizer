/**
 * Backfill legacy LLM category slugs to the robust enum introduced in
 * lib/classification/taxonomy.ts.
 *
 * Important:
 * - This script targets the three-layer schema tables:
 *   - `classifications` (baseline derivation rows)
 *   - `classification_reviews` (review overrides)
 * - It does NOT touch the removed `bug_report_classifications` table.
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

type ClassificationRow = {
  id: string
  category: string
  alternate_categories: string[] | null
  raw_json: Record<string, unknown> | null
}

type ReviewRow = {
  id: string
  category: string | null
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

interface MigrationStats {
  scanned: number
  updated: number
  fallbackCount: number
  fallbackSamples: Map<string, number>
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
  if ((CATEGORY_ENUM as readonly string[]).includes(value)) return value as IssueCategory
  return LEGACY_TO_ROBUST[value] ?? fallback
}

function recordFallback(stats: MigrationStats, legacyValue: string | null | undefined) {
  const key = legacyValue ?? "(null)"
  stats.fallbackCount += 1
  stats.fallbackSamples.set(key, (stats.fallbackSamples.get(key) ?? 0) + 1)
}

async function migrateClassifications(args: ParsedArgs): Promise<MigrationStats> {
  const admin = createAdminClient()
  const stats: MigrationStats = {
    scanned: 0,
    updated: 0,
    fallbackCount: 0,
    fallbackSamples: new Map<string, number>(),
  }

  let lastId: string | null = null
  while (true) {
    let query = admin
      .from("classifications")
      .select("id, category, alternate_categories, raw_json")
      .order("id", { ascending: true })
      .limit(args.batchSize)
    if (lastId) query = query.gt("id", lastId)

    const { data, error } = await query
    if (error) throw new Error(`[classifications] fetch failed: ${error.message}`)
    if (!data || data.length === 0) break

    for (const row of data as ClassificationRow[]) {
      stats.scanned += 1
      const nextCategory = mapCategory(row.category, args.fallback)
      const nextAlternates = (row.alternate_categories ?? []).map((v) => mapCategory(v, args.fallback))
      const nextRawJson = row.raw_json
        ? { ...row.raw_json, category: nextCategory, alternate_categories: nextAlternates }
        : row.raw_json

      const usedFallbackForPrimary =
        !(CATEGORY_ENUM as readonly string[]).includes(row.category) && !(row.category in LEGACY_TO_ROBUST)
      if (usedFallbackForPrimary) recordFallback(stats, row.category)

      const categoryChanged = row.category !== nextCategory
      const alternatesChanged = JSON.stringify(row.alternate_categories ?? []) !== JSON.stringify(nextAlternates)
      if (!categoryChanged && !alternatesChanged) continue

      if (args.apply) {
        const { error: updateError } = await admin
          .from("classifications")
          .update({
            category: nextCategory,
            alternate_categories: nextAlternates,
            raw_json: nextRawJson,
          })
          .eq("id", row.id)
        if (updateError) throw new Error(`[classifications] update failed for ${row.id}: ${updateError.message}`)
      }
      stats.updated += 1
    }

    lastId = data[data.length - 1]?.id ?? null
    if (data.length < args.batchSize) break
  }

  return stats
}

async function migrateClassificationReviews(args: ParsedArgs): Promise<MigrationStats> {
  const admin = createAdminClient()
  const stats: MigrationStats = {
    scanned: 0,
    updated: 0,
    fallbackCount: 0,
    fallbackSamples: new Map<string, number>(),
  }

  let lastId: string | null = null
  while (true) {
    let query = admin
      .from("classification_reviews")
      .select("id, category")
      .not("category", "is", null)
      .order("id", { ascending: true })
      .limit(args.batchSize)
    if (lastId) query = query.gt("id", lastId)

    const { data, error } = await query
    if (error) throw new Error(`[classification_reviews] fetch failed: ${error.message}`)
    if (!data || data.length === 0) break

    for (const row of data as ReviewRow[]) {
      stats.scanned += 1
      const nextCategory = mapCategory(row.category, args.fallback)
      const usedFallback =
        !!row.category &&
        !(CATEGORY_ENUM as readonly string[]).includes(row.category) &&
        !(row.category in LEGACY_TO_ROBUST)
      if (usedFallback) recordFallback(stats, row.category)
      if (row.category === nextCategory) continue

      if (args.apply) {
        const { error: updateError } = await admin
          .from("classification_reviews")
          .update({ category: nextCategory })
          .eq("id", row.id)
        if (updateError) throw new Error(`[classification_reviews] update failed for ${row.id}: ${updateError.message}`)
      }
      stats.updated += 1
    }

    lastId = data[data.length - 1]?.id ?? null
    if (data.length < args.batchSize) break
  }
  return stats
}

function collapseFallbackSamples(entries: Array<Map<string, number>>) {
  const merged = new Map<string, number>()
  for (const map of entries) {
    for (const [key, count] of map) merged.set(key, (merged.get(key) ?? 0) + count)
  }
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([legacy, count]) => ({ legacy, count }))
}

async function run() {
  const args = parseArgs(process.argv)
  if (args.apply && process.env.CATEGORY_MIGRATION_CONFIRM !== "yes") {
    console.error("Refusing to --apply without CATEGORY_MIGRATION_CONFIRM=yes.")
    process.exit(2)
  }

  const classifications = await migrateClassifications(args)
  const reviews = await migrateClassificationReviews(args)

  const summary = {
    mode: args.dryRun ? "dry-run" : "apply",
    fallback_category: args.fallback,
    classifications: {
      scanned_rows: classifications.scanned,
      updated_rows: classifications.updated,
      fallback_primary_count: classifications.fallbackCount,
      fallback_primary_samples: collapseFallbackSamples([classifications.fallbackSamples]),
    },
    classification_reviews: {
      scanned_rows: reviews.scanned,
      updated_rows: reviews.updated,
      fallback_primary_count: reviews.fallbackCount,
      fallback_primary_samples: collapseFallbackSamples([reviews.fallbackSamples]),
    },
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
