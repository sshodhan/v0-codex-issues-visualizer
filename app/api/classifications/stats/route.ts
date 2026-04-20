import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

interface ClassificationRow {
  category: string | null
  severity: string | null
  status: string | null
  needs_human_review: boolean | null
  source_issue_url: string | null
  source_issue_sentiment: "positive" | "negative" | "neutral" | null
}

export async function GET() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("bug_report_classifications")
    .select("category, severity, status, needs_human_review, source_issue_url, source_issue_sentiment")

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data || []) as ClassificationRow[]

  const byCategory: Record<string, number> = {}
  const bySeverity: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const bySentiment: Record<string, number> = { positive: 0, negative: 0, neutral: 0, unknown: 0 }

  let needsReviewCount = 0
  let traceableCount = 0

  rows.forEach((row) => {
    const category = row.category || "unknown"
    const severity = row.severity || "unknown"
    const status = row.status || "unknown"

    byCategory[category] = (byCategory[category] || 0) + 1
    bySeverity[severity] = (bySeverity[severity] || 0) + 1
    byStatus[status] = (byStatus[status] || 0) + 1

    if (row.needs_human_review) needsReviewCount++
    if (row.source_issue_url) traceableCount++

    if (!row.source_issue_sentiment) {
      bySentiment.unknown++
    } else {
      bySentiment[row.source_issue_sentiment]++
    }
  })

  return NextResponse.json({
    total: rows.length,
    needsReviewCount,
    traceableCount,
    traceabilityCoverage: rows.length ? Number(((traceableCount / rows.length) * 100).toFixed(1)) : 0,
    byCategory,
    bySeverity,
    byStatus,
    bySentiment,
  })
}
