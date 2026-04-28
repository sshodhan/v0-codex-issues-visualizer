/**
 * Deterministic cluster-label backfill (semantic_cluster_label v2 follow-up).
 *
 * CLI thin-wrapper around the shared orchestrator in
 * lib/storage/run-cluster-label-backfill.ts. Both this script and
 * /api/admin/cluster-label-backfill go through that helper so the
 * mode (dry-run / apply), candidate query, and `set_cluster_label`
 * RPC contract are guaranteed identical regardless of surface.
 *
 * Why this exists:
 * - Migration of `semantic_cluster_label` from v1 → v2 introduces a
 *   deterministic Topic+error fallback labeller
 *   (lib/storage/cluster-label-fallback.ts) so every cluster has a
 *   displayable label and the UI no longer renders "Unnamed family".
 *   Existing rows written under v1 either keep an old `fallback:title`
 *   stub at confidence 0.25 (suppressed by the UI) or sit at low LLM
 *   confidence — both classes need to be re-labelled once.
 *
 * Idempotence: re-running only re-touches rows still under 0.6, so
 * confident LLM labels written between runs are preserved.
 *
 * Safe order of operations:
 *   1) Deploy the v2 labeller pipeline.
 *   2) `node --experimental-strip-types scripts/021_backfill_deterministic_labels.ts --dry-run`
 *      — writes scripts/tmp/cluster-label-backfill-YYYYMMDD.json, no DB writes.
 *   3) Review: distribution of chosen models, sample of new labels,
 *      count of clusters left untouched (high LLM confidence already).
 *   4) `CLUSTER_LABEL_CONFIRM=yes node --experimental-strip-types scripts/021_backfill_deterministic_labels.ts --apply`
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createAdminClient } from "../lib/supabase/admin.ts"
import { runClusterLabelBackfill } from "../lib/storage/run-cluster-label-backfill.ts"

type ParsedArgs = {
  dryRun: boolean
  apply: boolean
  limit?: number
  batchSize: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { dryRun: true, apply: false, batchSize: 200 }
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") result.dryRun = true
    else if (arg === "--apply") {
      result.apply = true
      result.dryRun = false
    } else if (arg.startsWith("--limit=")) {
      result.limit = Number(arg.split("=")[1])
    } else if (arg.startsWith("--batch-size=")) {
      result.batchSize = Number(arg.split("=")[1])
    }
  }
  return result
}

async function run() {
  const args = parseArgs(process.argv)
  if (args.apply && process.env.CLUSTER_LABEL_CONFIRM !== "yes") {
    console.error("Refusing to --apply without CLUSTER_LABEL_CONFIRM=yes.")
    process.exit(2)
  }

  const admin = createAdminClient()
  const { summary, entries } = await runClusterLabelBackfill(admin, {
    apply: args.apply,
    limit: args.limit,
    batchSize: args.batchSize,
  })

  console.error(`[backfill] candidate clusters: ${summary.candidate_clusters}`)
  console.log(JSON.stringify(summary, null, 2))

  const here = path.dirname(fileURLToPath(import.meta.url))
  const tmpDir = path.join(here, "tmp")
  await mkdir(tmpDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const outPath = path.join(tmpDir, `cluster-label-backfill-${stamp}.json`)
  await writeFile(
    outPath,
    JSON.stringify({ summary, entries: entries.slice(0, 1000) }, null, 2),
  )
  console.error(`[backfill] wrote report to ${outPath}`)
}

run().catch((err) => {
  console.error("[backfill] failed:", err)
  process.exit(1)
})
