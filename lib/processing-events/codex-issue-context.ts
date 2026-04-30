export interface CodexIssueContextView {
  summary: string | null
  issueTitle: string | null
  issueNumber: number | null
  repo: string | null
  runId: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function readCodexIssueContext(
  detailJson: Record<string, unknown> | null | undefined,
): CodexIssueContextView | null {
  const root = asRecord(detailJson)
  if (!root) return null
  const metadata = asRecord(root.metadata)
  const context = asRecord(metadata?.codex_issue_context)
  if (!context) return null

  return {
    summary: asString(context.summary),
    issueTitle: asString(context.issue_title),
    issueNumber: asNumber(context.issue_number),
    repo: asString(context.repo),
    runId: asString(context.run_id),
  }
}

export function isCodexSelfReport(detailJson: Record<string, unknown> | null | undefined): boolean {
  const root = asRecord(detailJson)
  return root?.source === "codex-self-report"
}
