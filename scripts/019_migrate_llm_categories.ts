/**
 * Read-only preview for the v2 LLM-category backfill.
 *
 * The actual migration is `scripts/019_migrate_llm_categories.sql` and must be
 * run by the postgres / migration role:
 *
 *   psql "$SUPABASE_DB_URL" -f scripts/019_migrate_llm_categories.sql
 *
 * This TS script does NOT perform any writes. It cannot, by design — migration
 * 008 (`scripts/008_revoke_service_role_dml.sql`) revokes UPDATE on
 * `classifications` and `classification_reviews` from `service_role`, and this
 * file connects via `lib/supabase/admin.ts` (a service-role JWT). Use it to
 * preview the rows the SQL migration will touch and to confirm post-apply that
 * no legacy slugs remain.
 *
 * Usage:
 *   node --experimental-strip-types scripts/019_migrate_llm_categories.ts
 *   node --experimental-strip-types scripts/019_migrate_llm_categories.ts --report=tmp/preview.json
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createAdminClient } from "../lib/supabase/admin.ts"
import { CATEGORY_ENUM, type IssueCategory } from "../lib/classification/taxonomy.ts"

// Mirrors the CASE expressions in scripts/019_migrate_llm_categories.sql.
// Keep this map and the SQL CASE in lockstep.
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
  other: "user_intent_misinterpretation",
}

const LEGACY_SLUGS = Object.keys(LEGACY_TO_ROBUST)

interface ParsedArgs {
  reportPath?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--report=")) {
      out.reportPath = arg.slice("--report=".length)
    } else if (arg === "--apply") {
      throw new Error(
        "--apply is not supported in this script. The migration is SQL: " +
          'run `psql "$SUPABASE_DB_URL" -f scripts/019_migrate_llm_categories.sql`.',
      )
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node --experimental-strip-types scripts/019_migrate_llm_categories.ts [--report=PATH]\n" +
          "       Read-only preview of rows the v2 LLM-category SQL migration will touch.",
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}

interface CategoryCount {
  category: string
  rows: number
  remaps_to: IssueCategory
}

async function countByCategory(
  admin: ReturnType<typeof createAdminClient>,
  table: "classifications" | "classification_reviews",
): Promise<CategoryCount[]> {
  const result: CategoryCount[] = []
  for (const slug of LEGACY_SLUGS) {
    const { count, error } = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("category", slug)
    if (error) throw new Error(`[${table}] count for "${slug}" failed: ${error.message}`)
    if ((count ?? 0) > 0) {
      result.push({ category: slug, rows: count ?? 0, remaps_to: LEGACY_TO_ROBUST[slug] })
    }
  }
  return result
}

async function countAlternates(admin: ReturnType<typeof createAdminClient>): Promise<number> {
  const { count, error } = await admin
    .from("classifications")
    .select("id", { count: "exact", head: true })
    .overlaps("alternate_categories", LEGACY_SLUGS)
  if (error) throw new Error(`[classifications.alternate_categories] count failed: ${error.message}`)
  return count ?? 0
}

async function countLegacyReviewReason(
  admin: ReturnType<typeof createAdminClient>,
): Promise<number> {
  const { count, error } = await admin
    .from("classifications")
    .select("id", { count: "exact", head: true })
    .contains("review_reasons", ["safety_policy_category"])
  if (error) throw new Error(`[classifications.review_reasons] count failed: ${error.message}`)
  return count ?? 0
}

async function sampleUnknownCategories(
  admin: ReturnType<typeof createAdminClient>,
  table: "classifications" | "classification_reviews",
): Promise<{ count: number; samples: string[] }> {
  // Streams up to 1k category values, counts any that are neither in the v2
  // enum nor in the legacy set. If unknown values exist they will not be
  // touched by the SQL migration; flag them so the operator notices.
  const known = new Set<string>([...CATEGORY_ENUM, ...LEGACY_SLUGS])
  const { data, error } = await admin
    .from(table)
    .select("category")
    .limit(1000)
  if (error) throw new Error(`[${table}] unknown sample failed: ${error.message}`)
  const samples = new Set<string>()
  let count = 0
  for (const row of data ?? []) {
    const value = (row as { category: string | null }).category
    if (typeof value !== "string") continue
    if (known.has(value)) continue
    count += 1
    if (samples.size < 10) samples.add(value)
  }
  return { count, samples: [...samples] }
}

async function run() {
  const args = parseArgs(process.argv)
  const admin = createAdminClient()

  const classificationsByCategory = await countByCategory(admin, "classifications")
  const reviewsByCategory = await countByCategory(admin, "classification_reviews")
  const alternateRowCount = await countAlternates(admin)
  const reviewReasonRowCount = await countLegacyReviewReason(admin)
  const classificationsUnknown = await sampleUnknownCategories(admin, "classifications")
  const reviewsUnknown = await sampleUnknownCategories(admin, "classification_reviews")

  const summary = {
    generated_at: new Date().toISOString(),
    mode: "preview",
    legacy_to_v2_mapping: LEGACY_TO_ROBUST,
    classifications: {
      legacy_baseline_rows_by_category: classificationsByCategory,
      legacy_alternate_categories_rows: alternateRowCount,
      legacy_review_reason_rows: reviewReasonRowCount,
      unknown_category: classificationsUnknown,
    },
    classification_reviews: {
      legacy_category_rows_by_category: reviewsByCategory,
      unknown_category: reviewsUnknown,
    },
    next_step:
      'Apply: psql "$SUPABASE_DB_URL" -f scripts/019_migrate_llm_categories.sql',
  }

  console.log(JSON.stringify(summary, null, 2))

  if (classificationsUnknown.count > 0 || reviewsUnknown.count > 0) {
    console.error(
      `\nWARNING: found ${classificationsUnknown.count} classifications and ${reviewsUnknown.count} reviews with category values that are neither v2 nor legacy.\n` +
        "These rows will NOT be touched by the SQL migration. Inspect manually before applying.",
    )
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const tmpDir = path.join(here, "tmp")
  const stamp = summary.generated_at.slice(0, 10).replace(/-/g, "")
  const reportPath =
    args.reportPath ?? path.join(tmpDir, `llm-category-migration-preview-${stamp}.json`)
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  console.error(`\n[migration-019-preview] report written to ${reportPath}`)
}

run().catch((err) => {
  console.error("[migration-019-preview] failed:", err)
  process.exit(1)
})
