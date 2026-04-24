// Shared cron-run shape + derivation helpers.
//
// Both crons (/api/cron/scrape, /api/cron/classify-backfill) write rows
// into `scrape_logs`. The scrape cron writes one row per source per
// tick with source_id set; the backfill cron writes a single row with
// source_id = null. The admin "Cron jobs" tab surfaces both in one
// chronological feed, so callers need a shared labeling convention:
// `cron` names the job family, `source` names the data source for
// scrape rows (null for backfill), and duration is derived from
// started_at/completed_at on the fly (null while a run is still
// "running").

export type CronKind = "scrape" | "classify-backfill"

export type RunStatus = "pending" | "running" | "completed" | "failed"

export interface ScrapeLogRow {
  id: string
  source_id: string | null
  status: string
  issues_found: number | null
  issues_added: number | null
  error_message: string | null
  started_at: string
  completed_at: string | null
}

export interface SourceLookupRow {
  id: string
  slug: string
  name: string
}

export interface CronRun {
  id: string
  cron: CronKind
  source: { id: string; slug: string; name: string } | null
  status: RunStatus
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  issues_found: number
  issues_added: number
  error_message: string | null
}

// scrape_logs.status has a CHECK constraint (pending|running|completed|failed)
// but it's stored as text, so the admin UI should tolerate unexpected
// values without a crash. Anything outside the known set is clamped to
// "failed" so it still surfaces as an anomaly in the feed.
export function normalizeStatus(value: string): RunStatus {
  switch (value) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
      return value
    default:
      return "failed"
  }
}

export function deriveDurationMs(
  started_at: string,
  completed_at: string | null,
): number | null {
  if (!completed_at) return null
  const start = Date.parse(started_at)
  const end = Date.parse(completed_at)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, end - start)
}

// A scrape_logs row with source_id = null is, by the classify-backfill
// cron's own convention (see app/api/cron/classify-backfill/route.ts
// "Run summary is logged to scrape_logs(source_id=null)"), a
// backfill-cron audit row. Every other row is a per-source scrape.
export function cronForRow(row: ScrapeLogRow): CronKind {
  return row.source_id === null ? "classify-backfill" : "scrape"
}

export function buildCronRun(
  row: ScrapeLogRow,
  sourcesById: Map<string, SourceLookupRow>,
): CronRun {
  const source = row.source_id ? sourcesById.get(row.source_id) ?? null : null
  return {
    id: row.id,
    cron: cronForRow(row),
    source: source
      ? { id: source.id, slug: source.slug, name: source.name }
      : null,
    status: normalizeStatus(row.status),
    started_at: row.started_at,
    completed_at: row.completed_at,
    duration_ms: deriveDurationMs(row.started_at, row.completed_at),
    issues_found: row.issues_found ?? 0,
    issues_added: row.issues_added ?? 0,
    error_message: row.error_message,
  }
}

export interface CronRunFilters {
  cron?: CronKind
  // For scrape rows: match on source.slug. Ignored when cron is
  // "classify-backfill" (those rows have source = null by definition).
  sourceSlug?: string
  status?: RunStatus
}

export function matchesFilters(run: CronRun, filters: CronRunFilters): boolean {
  if (filters.cron && run.cron !== filters.cron) return false
  if (filters.status && run.status !== filters.status) return false
  if (filters.sourceSlug) {
    if (!run.source) return false
    if (run.source.slug !== filters.sourceSlug) return false
  }
  return true
}

// Stable chronological ordering: started_at desc, id desc as a
// tiebreaker so same-tick rows have a deterministic order in the UI.
export function sortCronRunsDesc(runs: CronRun[]): CronRun[] {
  return [...runs].sort((a, b) => {
    const ta = Date.parse(a.started_at)
    const tb = Date.parse(b.started_at)
    if (tb !== ta) return tb - ta
    if (a.id < b.id) return 1
    if (a.id > b.id) return -1
    return 0
  })
}
