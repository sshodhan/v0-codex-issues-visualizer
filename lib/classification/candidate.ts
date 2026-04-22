// Shared types and pure helpers used both by the classifier pipeline
// (lib/classification/pipeline.ts) and by callers that build candidates
// without pulling the full pipeline graph (e.g. the daily backfill cron
// in lib/classification/backfill-candidates.ts).
//
// Kept dependency-free so node:test can import it without resolving the
// `@/*` path alias (the test runner does not run through tsconfig
// paths, so any module reachable from a test must use relative imports
// with `.ts` extensions).

export interface ClassificationCandidate {
  observationId: string
  title: string
  reportText: string
  // Regex-derived structured context forwarded to classifyReport's
  // user-turn builder. The classifier schema (classifyInputSchema in
  // pipeline.ts) accepts both fields; we are enriching the prompt
  // payload, not changing the response contract. Absent when the
  // fingerprint extraction didn't find the relevant tokens.
  env?: Record<string, string>
  repro?: {
    count?: number
    last_seen?: string
    workspace_hash_if_shared?: string
  }
}

// Shared env-extraction rule: take the regex fingerprint's
// differentiator tokens (cli_version, os, shell, editor, model_id) and
// fold them into a prompt-payload `env` map, dropping null/empty
// tokens. Used by both the ingest-time candidate builder
// (lib/scrapers/index.ts → buildClassificationCandidate) and the daily
// backfill cron (lib/classification/backfill-candidates.ts →
// buildBackfillCandidates). Single source of truth prevents the two
// call sites from diverging when the classifier prompt contract
// changes.
//
// Field names on the inputs differ by context: the ingest path has a
// BugFingerprint object with `os/shell/editor`, while the backfill path
// reads flattened mv_observation_current columns where those columns
// were renamed to `fp_os/fp_shell/fp_editor` to avoid collisions with
// observation-level columns. This helper accepts both shapes — the
// caller passes whichever key it has.
export function buildEnvFromFingerprintColumns(input: {
  cli_version?: string | null
  os?: string | null
  shell?: string | null
  editor?: string | null
  model_id?: string | null
}): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  if (input.cli_version) env.cli_version = input.cli_version
  if (input.os) env.os = input.os
  if (input.shell) env.shell = input.shell
  if (input.editor) env.editor = input.editor
  if (input.model_id) env.model_id = input.model_id
  return Object.keys(env).length > 0 ? env : undefined
}

// Same rule for repro context: only emit when the fingerprint found
// at least one marker. Null/zero means "no signal," not "explicitly
// zero reproductions."
export function buildReproFromFingerprintMarkers(
  reproMarkers: number | null | undefined,
): { count: number } | undefined {
  return typeof reproMarkers === "number" && reproMarkers > 0
    ? { count: reproMarkers }
    : undefined
}

export function synthesizeObservationReportText(input: {
  title: string
  content?: string | null
  url?: string | null
  sourceSlug?: string | null
}): string {
  const lines = [
    `Observed issue from ${input.sourceSlug ?? "unknown-source"}:`,
    `Title: ${input.title}`,
  ]
  if (input.content && input.content.trim().length > 0) {
    lines.push(`Content: ${input.content.trim()}`)
  }
  if (input.url) {
    lines.push(`URL: ${input.url}`)
  }
  return lines.join("\n")
}
