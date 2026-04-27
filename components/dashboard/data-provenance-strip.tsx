"use client"

import Link from "next/link"
import { Clock } from "lucide-react"
import type { PipelineStateSummary } from "@/lib/classification/pipeline-state"

interface DataProvenanceStripProps {
  lastSyncLabel: string
  issueWindowLabel: string
  /** When set, strip shows replay hint with link to live */
  asOfActive: boolean
  pipelineState?: PipelineStateSummary | null
  className?: string
}

export function DataProvenanceStrip({
  lastSyncLabel,
  issueWindowLabel,
  asOfActive,
  pipelineState,
  className,
}: DataProvenanceStripProps) {
  const reviewerPipelineText = (() => {
    if (!pipelineState) return null

    if (pipelineState.data_state === "empty_healthy") {
      return "Reviewer view: no canonical observations in this window yet (pipeline healthy)."
    }
    if (pipelineState.data_state === "pending_classification") {
      return `Reviewer view: ${pipelineState.pending_classification} item${pipelineState.pending_classification === 1 ? "" : "s"} still awaiting classification.`
    }
    if (pipelineState.data_state === "degraded") {
      if (pipelineState.degraded_reason === "source_query_failed") {
        return "Reviewer view: pipeline status degraded — source query failed."
      }
      if (pipelineState.degraded_reason === "openai_unconfigured") {
        return "Reviewer view: pipeline degraded — OpenAI key missing, so new classifications cannot run."
      }
      if (pipelineState.degraded_reason === "classify_backfill_failed") {
        return "Reviewer view: pipeline degraded — latest classify-backfill failed."
      }
      return "Reviewer view: pipeline status is degraded."
    }
    return `Reviewer view: pipeline caught up (${pipelineState.classified_count}/${pipelineState.observations_in_window} classified in window).`
  })()

  return (
    <div
      className={`flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1 text-sm text-muted-foreground ${className ?? ""}`}
    >
      {reviewerPipelineText && (
        <span>
          <span className="font-medium text-foreground">Pipeline:</span> {reviewerPipelineText}
        </span>
      )}
      {asOfActive ? (
        <span className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Historical replay — numbers match that point in time.{" "}
          <Link href="/" className="font-medium text-primary underline-offset-4 hover:underline">
            Return to live
          </Link>
        </span>
      ) : (
        <span>
          <span className="font-medium text-foreground">How to use:</span> Click any category card to filter issues, or use the tabs above to switch between Dashboard and AI Classifications views.
        </span>
      )}
    </div>
  )
}
