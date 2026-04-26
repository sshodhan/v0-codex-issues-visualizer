/**
 * Deterministic cluster-label backfill (semantic_cluster_label v2 follow-up).
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
 * What this does:
 *   * Selects every cluster where the persisted label can be improved:
 *     `label_confidence < 0.6 OR label_model = 'fallback:title' OR
 *      label IS NULL`.
 *   * For each, pulls active members (`cluster_members` with
 *     `detached_at IS NULL`), then their dominant Topic
 *     (`category_assignments` → `categories.slug`) and recurring error
 *     codes (`bug_fingerprints.error_code`).
 *   * Composes a deterministic label via
 *     `composeDeterministicLabel(...)` and writes it via the
 *     `set_cluster_label` RPC with the right `lbl_model` tag (one of
 *     `deterministic:topic-and-error` / `:topic` / `:error` / `:title`)
 *     so audits via `clusters.label_model` keep working.
 *   * Does NOT call the OpenAI labeller. The live writer
 *     (lib/storage/semantic-clusters.ts) is the only place that calls
 *     the LLM; this backfill is the one-shot deterministic catch-up.
 *
 * Idempotence: re-running only re-touches rows still under 0.6, so
 * confident LLM labels written between runs are preserved. Rows where
 * the deterministic compose fails to improve confidence are still
 * rewritten (same value, same model tag) — that's fine, the RPC is an
 * UPDATE and the row's `labeling_updated_at` advances.
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
import {
  composeDeterministicLabel,
  type DeterministicLabel,
} from "../lib/storage/cluster-label-fallback.ts"
import { CURRENT_VERSIONS } from "../lib/storage/algorithm-versions.ts"

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

interface ClusterRow {
  id: string
  cluster_key: string | null
  label: string | null
  label_confidence: number | null
  label_model: string | null
}

interface BackfillEntry {
  cluster_id: string
  cluster_key: string | null
  member_count: number
  prior_label: string | null
  prior_confidence: number | null
  prior_model: string | null
  new_label: string
  new_confidence: number
  new_model: DeterministicLabel["model"]
}

async function run() {
  const args = parseArgs(process.argv)
  if (args.apply && process.env.CLUSTER_LABEL_CONFIRM !== "yes") {
    console.error("Refusing to --apply without CLUSTER_LABEL_CONFIRM=yes.")
    process.exit(2)
  }

  const admin = createAdminClient()

  // 1) Pull every cluster that needs improvement. Single round-trip is
  //    fine here — the cluster table is small relative to observations,
  //    and we want a stable snapshot for the dry-run report.
  let clusters: ClusterRow[] = []
  {
    let q = admin
      .from("clusters")
      .select("id, cluster_key, label, label_confidence, label_model")
      .or("label.is.null,label_confidence.lt.0.6,label_model.eq.fallback:title")
      .order("id", { ascending: true })
    if (args.limit) q = q.limit(args.limit)
    const { data, error } = await q
    if (error) {
      console.error("[backfill] cluster fetch failed:", error)
      process.exit(1)
    }
    clusters = (data ?? []) as ClusterRow[]
  }

  console.error(`[backfill] candidate clusters: ${clusters.length}`)

  const entries: BackfillEntry[] = []
  const modelTally: Record<string, number> = {}

  // 2) Walk the candidate set in chunks so we keep round-trip count
  //    bounded but don't pull every member at once.
  for (let i = 0; i < clusters.length; i += args.batchSize) {
    const chunk = clusters.slice(i, i + args.batchSize)
    const clusterIds = chunk.map((c) => c.id)

    const { data: memberRows, error: memberErr } = await admin
      .from("cluster_members")
      .select("cluster_id, observation_id")
      .in("cluster_id", clusterIds)
      .is("detached_at", null)
    if (memberErr) {
      console.error("[backfill] member fetch failed:", memberErr)
      process.exit(1)
    }
    const membersByCluster = new Map<string, string[]>()
    for (const m of (memberRows ?? []) as Array<{
      cluster_id: string
      observation_id: string
    }>) {
      const list = membersByCluster.get(m.cluster_id) ?? []
      list.push(m.observation_id)
      membersByCluster.set(m.cluster_id, list)
    }

    const allObsIds = Array.from(
      new Set(
        Array.from(membersByCluster.values()).flatMap((ids) => ids),
      ),
    )

    const titleByObs = new Map<string, string>()
    const topicSlugByObs = new Map<string, string>()
    const errorCodeByObs = new Map<string, string>()

    if (allObsIds.length > 0) {
      const [obsRes, catRes, fpRes] = await Promise.all([
        admin
          .from("observations")
          .select("id, title")
          .in("id", allObsIds),
        admin
          .from("category_assignments")
          .select("observation_id, computed_at, categories:category_id(slug)")
          .in("observation_id", allObsIds)
          .order("computed_at", { ascending: false }),
        admin
          .from("bug_fingerprints")
          .select("observation_id, error_code, computed_at")
          .in("observation_id", allObsIds)
          .not("error_code", "is", null)
          .order("computed_at", { ascending: false }),
      ])

      for (const row of (obsRes.data ?? []) as Array<{ id: string; title: string | null }>) {
        if (row.title) titleByObs.set(row.id, row.title)
      }
      // Latest assignment per observation wins (already ordered desc).
      // PostgREST returns the embedded `categories(slug)` as a single
      // object at runtime, but Supabase's typings model it as an array
      // — cast through unknown. Same pattern as scripts/013.
      for (const row of (catRes.data ?? []) as unknown as Array<{
        observation_id: string
        categories: { slug: string } | null
      }>) {
        if (!topicSlugByObs.has(row.observation_id) && row.categories?.slug) {
          topicSlugByObs.set(row.observation_id, row.categories.slug)
        }
      }
      for (const row of (fpRes.data ?? []) as Array<{
        observation_id: string
        error_code: string | null
      }>) {
        if (!errorCodeByObs.has(row.observation_id) && row.error_code) {
          errorCodeByObs.set(row.observation_id, row.error_code)
        }
      }
    }

    for (const cluster of chunk) {
      const memberIds = membersByCluster.get(cluster.id) ?? []
      const titles = memberIds
        .map((id) => titleByObs.get(id) ?? "")
        .filter((t) => t.length > 0)
      const topicSlugs = memberIds.map((id) => topicSlugByObs.get(id) ?? null)
      const errorCodes = memberIds.map((id) => errorCodeByObs.get(id) ?? null)

      const fallback = composeDeterministicLabel({ topicSlugs, errorCodes, titles })
      const entry: BackfillEntry = {
        cluster_id: cluster.id,
        cluster_key: cluster.cluster_key,
        member_count: memberIds.length,
        prior_label: cluster.label,
        prior_confidence: cluster.label_confidence,
        prior_model: cluster.label_model,
        new_label: fallback.label,
        new_confidence: fallback.confidence,
        new_model: fallback.model,
      }
      entries.push(entry)
      modelTally[fallback.model] = (modelTally[fallback.model] ?? 0) + 1

      if (args.apply) {
        const { error } = await admin.rpc("set_cluster_label", {
          cluster_uuid: cluster.id,
          lbl: fallback.label,
          lbl_rationale: fallback.rationale,
          lbl_confidence: fallback.confidence,
          lbl_model: fallback.model,
          lbl_alg_ver: CURRENT_VERSIONS.semantic_cluster_label,
        })
        if (error) {
          console.error(`[backfill] set_cluster_label failed for ${cluster.id}:`, error)
        }
      }
    }
  }

  const summary = {
    mode: args.dryRun ? "dry-run" : "apply",
    candidate_clusters: clusters.length,
    relabelled: entries.length,
    by_model: modelTally,
  }
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
