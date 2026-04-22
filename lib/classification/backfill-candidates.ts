import {
  buildEnvFromFingerprintColumns,
  buildReproFromFingerprintMarkers,
  synthesizeObservationReportText,
  type ClassificationCandidate,
} from "./candidate.ts"
// Note: relative `.ts` import is required so node:test
// (--experimental-strip-types) can resolve this file without a
// `@/*` alias plugin. Next.js + Turbopack tolerate the suffix on
// imports as well.

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
      // mv_observation_current renames the fingerprint os/shell/editor
      // columns to fp_* (collision avoidance with observation-level
      // columns); the shared helper accepts either name.
      env: buildEnvFromFingerprintColumns({
        cli_version: row.cli_version,
        os: row.fp_os,
        shell: row.fp_shell,
        editor: row.fp_editor,
        model_id: row.model_id,
      }),
      repro: buildReproFromFingerprintMarkers(row.repro_markers),
    }
  })
}
