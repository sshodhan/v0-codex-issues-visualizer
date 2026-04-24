"use client"

import { DataProvenanceStrip } from "@/components/dashboard/data-provenance-strip"
import type { PipelineStateSummary } from "@/lib/classification/pipeline-state"

type Props = {
  lastSyncLabel: string
  asOfActive: boolean
  timeDays: number
  issueCountInScope: number
  /** LLM triage row count in current scope (after time + known LLM category filter) */
  classificationRowCount: number
  pipelineState?: PipelineStateSummary | null
}

/**
 * V2-only: explains why global filter "issues" can differ from LLM classification counts.
 */
export function ClassificationTabStrip({
  lastSyncLabel,
  asOfActive,
  timeDays,
  issueCountInScope,
  classificationRowCount,
  pipelineState,
}: Props) {
  const timeLabel = timeDays === 0 ? "All time" : `Last ${timeDays} days`
  return (
    <div className="space-y-2">
      <DataProvenanceStrip
        lastSyncLabel={lastSyncLabel}
        issueWindowLabel={timeLabel}
        asOfActive={asOfActive}
        pipelineState={pipelineState}
      />
      <p className="text-xs text-muted-foreground border border-dashed border-border/80 rounded-md px-3 py-2 bg-muted/20">
        <span className="font-medium text-foreground">This tab: </span>
        <strong>{classificationRowCount}</strong> LLM classification
        {classificationRowCount === 1 ? "" : "s"} in scope
        {timeDays > 0 ? ` (created in ${timeLabel.toLowerCase()})` : ""}. The global category
        slider above counts <strong>{issueCountInScope}</strong> scraped issue
        {issueCountInScope === 1 ? "" : "s"} in the same time window (heuristic categories) — they
        are different layers, so 66 vs 0 is expected until the classifier and backfill have run.
      </p>
    </div>
  )
}
