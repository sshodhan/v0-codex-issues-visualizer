import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  buildCronRun,
  sortCronRunsDesc,
  type CronRun,
  type ScrapeLogRow,
  type SourceLookupRow,
} from "@/lib/cron-runs/shape"
import { logServerError } from "@/lib/error-tracking/server-logger"

export const maxDuration = 15

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

// Schedules are duplicated from vercel.json because vercel.json lives
// at build time on Vercel and isn't readable from the running route.
// If you change a schedule in vercel.json, update this list in the
// same commit — the admin UI reads it verbatim.
const CRON_SCHEDULES = [
  { cron: "scrape", path: "/api/cron/scrape", schedule: "0 */6 * * *" },
  {
    cron: "classify-backfill",
    path: "/api/cron/classify-backfill",
    schedule: "0 3 * * *",
  },
] as const

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const url = new URL(request.url)
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT)
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, MAX_LIMIT),
  )

  const supabase = createAdminClient()

  // Pull the raw rows and the source lookup in parallel — the lookup
  // is small (one row per configured source) and rarely changes.
  const [runsRes, sourcesRes] = await Promise.all([
    supabase
      .from("scrape_logs")
      .select(
        "id, source_id, status, issues_found, issues_added, error_message, started_at, completed_at",
      )
      .order("started_at", { ascending: false })
      .limit(limit),
    supabase.from("sources").select("id, slug, name"),
  ])

  if (runsRes.error) {
    logServerError("admin-cron-runs", "runs_query_failed", runsRes.error)
    return NextResponse.json({ error: runsRes.error.message }, { status: 500 })
  }
  if (sourcesRes.error) {
    logServerError("admin-cron-runs", "sources_query_failed", sourcesRes.error)
    return NextResponse.json({ error: sourcesRes.error.message }, { status: 500 })
  }

  const sourcesById = new Map<string, SourceLookupRow>()
  for (const s of (sourcesRes.data ?? []) as SourceLookupRow[]) {
    sourcesById.set(s.id, s)
  }

  const runs: CronRun[] = sortCronRunsDesc(
    ((runsRes.data ?? []) as ScrapeLogRow[]).map((r) => buildCronRun(r, sourcesById)),
  )

  // Per-cron "last run" summary card input. Scan once on the server so
  // the UI doesn't have to re-walk the list each render.
  const lastByCron: Record<string, CronRun | null> = {
    scrape: null,
    "classify-backfill": null,
  }
  for (const r of runs) {
    if (lastByCron[r.cron] === null) lastByCron[r.cron] = r
    if (lastByCron.scrape && lastByCron["classify-backfill"]) break
  }

  const availableSources = Array.from(sourcesById.values())
    .map((s) => ({ slug: s.slug, name: s.name }))
    .sort((a, b) => a.slug.localeCompare(b.slug))

  return NextResponse.json(
    {
      runs,
      schedules: CRON_SCHEDULES,
      availableSources,
      lastByCron,
      limit,
    },
    { headers: { "cache-control": "no-store" } },
  )
}
