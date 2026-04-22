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
