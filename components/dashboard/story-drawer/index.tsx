"use client"

import { useMemo } from "react"
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ClusterRollupRow, Issue } from "@/hooks/use-dashboard-data"
import { formatLlmCategorySlug } from "@/lib/dashboard/story-category-atlas-layout"
import type { StoryDrawerTarget } from "./types"
import { HeuristicLlmDrawerContent } from "./heuristic-llm-content"
import { ClusterDrawerContent } from "./cluster-content"
import { IssueDrawerContent } from "./issue-content"

export interface StoryDrawerActions {
  onSelectHeuristicSlug: (slug: string) => void
  onOpenLlmInTriage: (llmCategorySlug: string) => void
  onOpenIssuesTable: () => void
  onOpenClusterInTable: (clusterId: string) => void
  onOpenClusterInTriage: (clusterId: string) => void
  onDrillErrorCode: (compoundKey: string) => void
}

interface Props extends StoryDrawerActions {
  target: StoryDrawerTarget
  onClose: () => void
  onChangeTarget: (target: StoryDrawerTarget) => void
  issues: Issue[]
  clusterRows: ClusterRollupRow[] | undefined
  windowMs: { startMs: number; endMs: number }
  selectedHeuristicSlug: string
  selectedLlmCategorySlug: string | null
}

/**
 * Story-tab side drawer. Single shell that swaps content by `target.kind`.
 *
 * Renders Sheet (slide-in from right) on desktop, vaul Drawer (bottom sheet) on
 * mobile — both already part of the design system. Content scrolls inside the
 * shell; the close affordance (X) is provided by SheetContent. Esc closes both.
 */
export function StoryDrawer({
  target,
  onClose,
  onChangeTarget,
  issues,
  clusterRows,
  windowMs,
  selectedHeuristicSlug,
  selectedLlmCategorySlug,
  onSelectHeuristicSlug,
  onOpenLlmInTriage,
  onOpenIssuesTable,
  onOpenClusterInTable,
  onOpenClusterInTriage,
  onDrillErrorCode,
}: Props) {
  const isMobile = useIsMobile()
  const open = target !== null

  const cluster = useMemo<ClusterRollupRow | null>(() => {
    if (target?.kind !== "cluster") return null
    return (clusterRows ?? []).find((r) => r.id === target.clusterId) ?? null
  }, [target, clusterRows])

  const issue = useMemo<Issue | null>(() => {
    if (target?.kind !== "issue") return null
    return issues.find((i) => i.id === target.issueId) ?? null
  }, [target, issues])

  // Title + description for the underlying Radix Dialog. Visible in screen readers
  // only — the in-content <h3> remains the visual heading. Required by Radix
  // (DialogContent without a Title logs an a11y warning in dev).
  const a11y = useMemo(() => {
    if (!target) return { title: "Detail", description: "" }
    if (target.kind === "heuristic")
      return {
        title: `Heuristic topic: ${target.label}`,
        description: "Detail panel showing volume, sentiment, sources, and top reports.",
      }
    if (target.kind === "llm")
      return {
        title: `LLM category: ${target.label}`,
        description: "Detail panel showing volume, sentiment, sources, and top reports.",
      }
    if (target.kind === "cluster")
      return {
        title: cluster?.representative_title?.trim() || cluster?.label?.trim() || "Cluster detail",
        description: "Detail panel for a cluster of related reports.",
      }
    if (target.kind === "issue")
      return {
        title: issue?.title ?? "Issue detail",
        description: "Detail panel for a single report with similar reports from its cluster.",
      }
    return { title: "Detail", description: "" }
  }, [target, cluster, issue])

  const body = useMemo(() => {
    if (!target) return null
    if (target.kind === "heuristic") {
      const isAlreadyApplied = selectedHeuristicSlug === target.slug
      return (
        <HeuristicLlmDrawerContent
          target={target}
          issues={issues}
          windowMs={windowMs}
          isAlreadyApplied={isAlreadyApplied}
          onUseAsFilter={() => {
            onSelectHeuristicSlug(target.slug)
            onClose()
          }}
          onOpenAllInTable={() => {
            onSelectHeuristicSlug(target.slug)
            onOpenIssuesTable()
            onClose()
          }}
          onDrillErrorCode={(code) => {
            onDrillErrorCode(`err:${code}`)
            onClose()
          }}
          onSelectIssue={(id) => onChangeTarget({ kind: "issue", issueId: id })}
        />
      )
    }
    if (target.kind === "llm") {
      const slug = formatLlmCategorySlug(target.slug)
      const isAlreadyApplied = selectedLlmCategorySlug === slug
      return (
        <HeuristicLlmDrawerContent
          target={target}
          issues={issues}
          windowMs={windowMs}
          isAlreadyApplied={isAlreadyApplied}
          onUseAsFilter={() => {
            onOpenLlmInTriage(slug)
            onClose()
          }}
          onOpenAllInTable={() => {
            onOpenLlmInTriage(slug)
            onClose()
          }}
          onDrillErrorCode={(code) => {
            onDrillErrorCode(`err:${code}`)
            onClose()
          }}
          onSelectIssue={(id) => onChangeTarget({ kind: "issue", issueId: id })}
        />
      )
    }
    if (target.kind === "cluster") {
      return (
        <ClusterDrawerContent
          cluster={cluster}
          clusterId={target.clusterId}
          onOpenInTable={() => {
            onOpenClusterInTable(target.clusterId)
            onClose()
          }}
          onOpenInTriage={() => {
            onOpenClusterInTriage(target.clusterId)
            onClose()
          }}
          onSelectIssue={(id) => onChangeTarget({ kind: "issue", issueId: id })}
        />
      )
    }
    if (target.kind === "issue") {
      return (
        <IssueDrawerContent
          issue={issue}
          onOpenCluster={(clusterId) =>
            onChangeTarget({ kind: "cluster", clusterId })
          }
          onSelectIssue={(id) => onChangeTarget({ kind: "issue", issueId: id })}
        />
      )
    }
    return null
  }, [
    target,
    issue,
    cluster,
    issues,
    windowMs,
    selectedHeuristicSlug,
    selectedLlmCategorySlug,
    onSelectHeuristicSlug,
    onOpenLlmInTriage,
    onOpenIssuesTable,
    onOpenClusterInTable,
    onOpenClusterInTriage,
    onDrillErrorCode,
    onClose,
    onChangeTarget,
  ])

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
        <DrawerContent className="max-h-[88vh] motion-reduce:transition-none">
          <DrawerTitle className="sr-only">{a11y.title}</DrawerTitle>
          <DrawerDescription className="sr-only">{a11y.description}</DrawerDescription>
          <div className="flex h-full max-h-[88vh] flex-col">{body}</div>
        </DrawerContent>
      </Drawer>
    )
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full p-0 sm:max-w-md md:max-w-lg lg:max-w-xl motion-reduce:transition-none"
      >
        <SheetTitle className="sr-only">{a11y.title}</SheetTitle>
        <SheetDescription className="sr-only">{a11y.description}</SheetDescription>
        {body}
      </SheetContent>
    </Sheet>
  )
}
