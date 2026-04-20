export interface ClassificationEnv {
  cli_version?: string
  os?: string
  shell?: string
  editor?: string
  workspace_lang?: string
  model_id?: string
  org_tier?: string
}

export interface ClassificationRepro {
  count?: number
  last_seen?: string
  workspace_hash_if_shared?: string
}

export interface TailLine {
  text: string
}

export interface TimedTailLine {
  ts?: string
  event?: string
  payload_summary?: string
  level?: string
  message?: string
}

export interface BuildReportSummaryInput {
  report_text: string
  env?: ClassificationEnv
  repro?: ClassificationRepro
  transcript_tail?: TailLine[]
  tool_calls_tail?: TailLine[]
  breadcrumbs?: TimedTailLine[]
  logs?: TimedTailLine[]
  screenshot_or_diff?: string
  maxTailItems?: number
}

function renderTail(title: string, lines: string[]): string {
  const body = lines.length > 0 ? lines.join("\n") : "none"
  return `## ${title}\n${body}`
}

function cap<T>(arr: T[] | undefined, maxItems: number): T[] {
  if (!arr || arr.length === 0) return []
  return arr.slice(-maxItems)
}

export function buildClassificationUserTurn(input: BuildReportSummaryInput): string {
  const maxTailItems = input.maxTailItems ?? 10

  const env = input.env ?? {}
  const repro = input.repro ?? {}

  const transcriptLines = cap(input.transcript_tail, maxTailItems).map((item) => item.text)
  const toolCallLines = cap(input.tool_calls_tail, maxTailItems).map((item) => item.text)
  const breadcrumbLines = cap(input.breadcrumbs, 10).map((item) => `${item.ts ?? ""} ${item.event ?? ""} ${item.payload_summary ?? ""}`.trim())
  const logLines = cap(input.logs, 10).map((item) => `${item.level ?? ""} ${item.ts ?? ""} ${item.message ?? ""}`.trim())

  return [
    `## report_text\n<<<${input.report_text}>>>`,
    `## env\ncli_version=${env.cli_version ?? "unknown"} os=${env.os ?? "unknown"} shell=${env.shell ?? "unknown"} editor=${env.editor ?? "unknown"}\nworkspace_lang=${env.workspace_lang ?? "unknown"} model_id=${env.model_id ?? "unknown"} org_tier=${env.org_tier ?? "unknown"}`,
    `## repro\ncount=${repro.count ?? "unknown"} last_seen=${repro.last_seen ?? "unknown"} workspace_hash=${repro.workspace_hash_if_shared ?? "none"}`,
    renderTail(`transcript_tail (last ${maxTailItems} turns, oldest first)`, transcriptLines),
    renderTail(`tool_calls_tail (last ${maxTailItems})`, toolCallLines),
    renderTail("breadcrumbs (last 10)", breadcrumbLines),
    renderTail("logs (errors/warnings only, last 10)", logLines),
    `## screenshot_or_diff\n${input.screenshot_or_diff ?? "none"}`,
  ].join("\n\n")
}
