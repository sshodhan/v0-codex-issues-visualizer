import {
  synthesizeObservationReportText,
  type ClassificationCandidate,
} from "./candidate.ts"

// Subset of mv_observation_current columns the classify-backfill cron
// pulls. Kept in lock-step with the SELECT in
// app/api/cron/classify-backfill/route.ts so the two definitions can't
// drift independently. The shape is intentionally permissive (nullable
// fingerprint columns) — pre-013-backfill rows have no fingerprint, so
// every regex-derived field must be optional.
export interface BackfillSourceRow {
  observation_id: string
  title: string
  content: string | null
  url: string | null
  source_id: string | null
  cli_version: string | null
  fp_os: string | null
  fp_shell: string | null
  fp_editor: string | null
  model_id: string | null
  repro_markers: number | null
}

// Mirrors lib/scrapers/index.ts → buildClassificationCandidate so the
// classifier receives identical structured env/repro context whether a
// candidate came from the ingest-time queue or the daily backfill cron.
// Pure projection — no I/O — so fixture-driven tests can exercise it
// without mocking Supabase.
export function buildBackfillCandidates(
  rows: BackfillSourceRow[],
  slugById: Map<string, string>,
): ClassificationCandidate[] {
  return rows.map((row) => {
    const env: Record<string, string> = {}
    if (row.cli_version) env.cli_version = row.cli_version
    if (row.fp_os) env.os = row.fp_os
    if (row.fp_shell) env.shell = row.fp_shell
    if (row.fp_editor) env.editor = row.fp_editor
    if (row.model_id) env.model_id = row.model_id

    const sourceSlug = row.source_id ? slugById.get(row.source_id) ?? null : null

    return {
      observationId: row.observation_id,
      title: row.title,
      reportText: synthesizeObservationReportText({
        title: row.title,
        content: row.content,
        url: row.url,
        sourceSlug,
      }),
      env: Object.keys(env).length > 0 ? env : undefined,
      repro:
        typeof row.repro_markers === "number" && row.repro_markers > 0
          ? { count: row.repro_markers }
          : undefined,
    }
  })
}
