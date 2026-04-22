/**
 * Bug-fingerprint backfill (migration 013 follow-up).
 *
 * Why this exists:
 * - Migration 013 introduces the `bug_fingerprints` derivation. New
 *   ingests populate it automatically (lib/scrapers/index.ts). Older
 *   observations need a one-shot backfill so the SignalLayers panel,
 *   priority-matrix tooltip, and issues-table chips have something to
 *   render across the full history.
 *
 * What this does:
 *   * Reads every observation, runs the deterministic regex extractor on
 *     title + content, writes a v1 `bug_fingerprints` row.
 *   * Computes the compound cluster-key label (title|err|frame) per row
 *     and stores it on the fingerprint row for audit.
 *   * Does NOT rebuild semantic cluster memberships — that's owned by
 *     the embedding pass in lib/storage/semantic-clusters.ts. The
 *     fingerprint is a sub-cluster label that coexists with whatever
 *     the semantic pass decided.
 *   * Does NOT call the LLM. The classification queue
 *     (lib/classification/pipeline.ts) is the scaled writer for
 *     llm_subcategory / llm_primary_tag; this backfill leaves those
 *     nulls on rows it touches so the LLM pass can fill them later.
 *
 * Safe order of operations:
 *   1) Apply scripts/013_bug_fingerprints.sql (creates table + RPC + MV).
 *   2) `node --experimental-strip-types scripts/013_backfill_fingerprints.ts --dry-run`
 *      — writes scripts/tmp/fingerprint-backfill-YYYYMMDD.json, no DB writes.
 *   3) Review: distribution of extracted error codes / frames, fraction
 *      of observations where the compound key differs from the existing
 *      cluster_key (sub-cluster opportunity), any unexpectedly-large
 *      shrinkers.
 *   4) `FINGERPRINT_CONFIRM=yes node --experimental-strip-types scripts/013_backfill_fingerprints.ts --apply`
 *
 * Idempotence: `record_bug_fingerprint` is ON CONFLICT DO NOTHING keyed
 * on (observation_id, algorithm_version), so re-running --apply is a
 * no-op for already-written rows.
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createAdminClient } from "../lib/supabase/admin.ts"
import {
  buildCompoundClusterKey,
  extractBugFingerprint,
} from "../lib/scrapers/bug-fingerprint.ts"
import { buildTitleClusterKey } from "../lib/storage/cluster-key.ts"

type ObservationRow = {
  id: string
  title: string
  content: string | null
  cluster_key: string | null
}

type ParsedArgs = {
  dryRun: boolean
  apply: boolean
  limit?: number
  batchSize: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { dryRun: true, apply: false, batchSize: 500 }
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

interface BackfillEntry {
  observation_id: string
  existing_cluster_key: string | null
  compound_key: string
  differs_from_cluster: boolean
  error_code: string | null
  top_stack_frame: string | null
}

async function run() {
  const args = parseArgs(process.argv)
  if (args.apply && process.env.FINGERPRINT_CONFIRM !== "yes") {
    console.error("Refusing to --apply without FINGERPRINT_CONFIRM=yes.")
    process.exit(2)
  }

  const admin = createAdminClient()
  const entries: BackfillEntry[] = []
  const subClusterDeltas: Record<string, number> = {}

  let lastId: string | null = null
  let processed = 0

  while (true) {
    if (args.limit && processed >= args.limit) break
    const batchSize = Math.min(args.batchSize, args.limit ? args.limit - processed : args.batchSize)

    let query = admin
      .from("observations")
      .select("id, title, content")
      .order("id", { ascending: true })
      .limit(batchSize)
    if (lastId) query = query.gt("id", lastId)

    const { data, error } = await query
    if (error) {
      console.error("[backfill] fetch failed:", error)
      process.exit(1)
    }
    if (!data || data.length === 0) break

    // Pull the current (semantic) cluster membership for each observation
    // in the batch. We don't touch membership — this is diagnostic only,
    // so the dry-run report shows how often the compound fingerprint key
    // differs from the semantic cluster_key (a sub-cluster opportunity).
    const ids = data.map((r) => r.id)
    const { data: memberships } = await admin
      .from("cluster_members")
      .select("observation_id, cluster_id, clusters:cluster_id(cluster_key)")
      .in("observation_id", ids)
      .is("detached_at", null)
    const currentKey = new Map<string, string>()
    for (const m of (memberships ?? []) as Array<{
      observation_id: string
      clusters: { cluster_key: string } | null
    }>) {
      if (m.clusters?.cluster_key) currentKey.set(m.observation_id, m.clusters.cluster_key)
    }

    for (const row of data as ObservationRow[]) {
      const fingerprint = extractBugFingerprint({ title: row.title, content: row.content })
      const compoundKey = buildCompoundClusterKey(row.title, fingerprint)
      const existing = currentKey.get(row.id) ?? buildTitleClusterKey(row.title)

      const entry: BackfillEntry = {
        observation_id: row.id,
        existing_cluster_key: existing,
        compound_key: compoundKey,
        differs_from_cluster: existing !== compoundKey,
        error_code: fingerprint.error_code,
        top_stack_frame: fingerprint.top_stack_frame,
      }
      entries.push(entry)
      if (entry.differs_from_cluster) {
        subClusterDeltas[existing] = (subClusterDeltas[existing] ?? 0) + 1
      }

      if (args.apply) {
        await admin.rpc("record_bug_fingerprint", {
          obs_id: row.id,
          ver: "v1",
          payload: {
            ...fingerprint,
            cluster_key_compound: compoundKey,
          } as any,
        })
      }
    }

    lastId = data[data.length - 1].id
    processed += data.length
    if (data.length < batchSize) break
  }

  // Summary report
  const differs = entries.filter((e) => e.differs_from_cluster).length
  const errorCodesExtracted = entries.filter((e) => e.error_code).length
  const framesExtracted = entries.filter((e) => e.top_stack_frame).length

  const heaviestSubClusters = Object.entries(subClusterDeltas)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, count]) => ({ existing_cluster_key: key, observations_with_distinct_fingerprint: count }))

  const summary = {
    mode: args.dryRun ? "dry-run" : "apply",
    total_observations: entries.length,
    differ_from_cluster: differs,
    percent_sub_clustered: entries.length ? Math.round((differs / entries.length) * 100) : 0,
    error_codes_extracted: errorCodesExtracted,
    frames_extracted: framesExtracted,
    heaviest_sub_clusters: heaviestSubClusters,
  }

  console.log(JSON.stringify(summary, null, 2))

  const here = path.dirname(fileURLToPath(import.meta.url))
  const tmpDir = path.join(here, "tmp")
  await mkdir(tmpDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const outPath = path.join(tmpDir, `fingerprint-backfill-${stamp}.json`)
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
