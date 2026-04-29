/**
 * Backfill `observations.canonical_url` for rows captured before the
 * second-tier dedup landed (migration 030). The column ships nullable so
 * the diagnostic index simply ignores legacy rows; this backfill closes
 * that gap so duplicate-detection works against the full corpus rather
 * than just newly-scraped content.
 *
 * Strictly additive: only updates rows where `canonical_url IS NULL` and
 * the source `url` parses through `lib/scrapers/url.ts`. Re-running is a
 * no-op once every row has been touched.
 *
 * NOT included here: dedup-cleanup of pre-existing duplicate pairs. The
 * issue caveats note that detaching duplicates from clusters orphans
 * `family_classifications`, so that step needs to coordinate with a
 * Layer 0 / cluster rebuild cycle and is intentionally left as
 * follow-up work.
 *
 * Usage:
 *   node --experimental-strip-types scripts/030_backfill_canonical_urls.ts --dry-run
 *   CANONICAL_URL_BACKFILL_CONFIRM=yes \
 *     node --experimental-strip-types scripts/030_backfill_canonical_urls.ts --apply
 */

import { createAdminClient } from "../lib/supabase/admin.ts"
import { canonicalizeUrl } from "../lib/scrapers/url.ts"

type ParsedArgs = {
  dryRun: boolean
  apply: boolean
  batchSize: number
  limit?: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { dryRun: true, apply: false, batchSize: 500 }
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") result.dryRun = true
    else if (arg === "--apply") {
      result.apply = true
      result.dryRun = false
    } else if (arg.startsWith("--batch-size=")) {
      result.batchSize = Number(arg.split("=")[1])
    } else if (arg.startsWith("--limit=")) {
      result.limit = Number(arg.split("=")[1])
    }
  }
  return result
}

async function run() {
  const args = parseArgs(process.argv)
  if (args.apply && process.env.CANONICAL_URL_BACKFILL_CONFIRM !== "yes") {
    console.error(
      "Refusing to --apply without CANONICAL_URL_BACKFILL_CONFIRM=yes.",
    )
    process.exit(2)
  }

  const admin = createAdminClient()
  let updated = 0
  let scanned = 0
  let skippedNullUrl = 0
  let lastId: string | null = null

  while (true) {
    let query = admin
      .from("observations")
      .select("id, url")
      .is("canonical_url", null)
      .order("id", { ascending: true })
      .limit(args.batchSize)
    if (lastId) query = query.gt("id", lastId)

    const { data, error } = await query
    if (error) {
      console.error("[backfill] select failed:", error)
      process.exit(1)
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      scanned++
      const canonical = canonicalizeUrl(row.url)
      if (!canonical) {
        skippedNullUrl++
        continue
      }
      if (args.apply) {
        const { error: updateError } = await admin
          .from("observations")
          .update({ canonical_url: canonical })
          .eq("id", row.id)
        if (updateError) {
          console.error(`[backfill] update ${row.id} failed:`, updateError)
          process.exit(1)
        }
      }
      updated++
      if (args.limit && updated >= args.limit) break
    }

    lastId = data[data.length - 1].id
    if (args.limit && updated >= args.limit) break
  }

  const report = {
    mode: args.dryRun ? "dry-run" : "apply",
    scanned,
    updated,
    skipped_null_url: skippedNullUrl,
  }
  console.log(JSON.stringify(report, null, 2))
}

run().catch((err) => {
  console.error("[backfill] failed:", err)
  process.exit(1)
})
