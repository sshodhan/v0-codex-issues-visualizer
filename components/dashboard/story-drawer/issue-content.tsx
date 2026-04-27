"use client"

import { useMemo } from "react"
import { format, parseISO } from "date-fns"
import { ExternalLink, Layers3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Issue } from "@/hooks/use-dashboard-data"
import { useIssues } from "@/hooks/use-dashboard-data"
import { DrawerSection } from "./section"
import { IssueList } from "./issue-list"

const SNIPPET_MAX = 360

interface Props {
  issue: Issue | null
  onOpenCluster: (clusterId: string) => void
  onSelectIssue: (issueId: string) => void
}

export function IssueDrawerContent({ issue, onOpenCluster, onSelectIssue }: Props) {
  const clusterId = issue?.cluster_id ?? null
  const { issues: similar, isLoading } = useIssues(
    clusterId ? { cluster_id: clusterId, sortBy: "impact_score", order: "desc" } : undefined,
  )
  const similarTrimmed = useMemo(
    () => similar.filter((s) => s.id !== issue?.id).slice(0, 4),
    [similar, issue?.id],
  )

  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm italic text-muted-foreground">Issue not found.</p>
      </div>
    )
  }

  const snippet = issue.content?.trim()
    ? issue.content.trim().slice(0, SNIPPET_MAX) +
      (issue.content.trim().length > SNIPPET_MAX ? "…" : "")
    : null

  const date = issue.published_at
    ? format(parseISO(issue.published_at), "MMM d, yyyy")
    : null

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-1.5 px-4 pt-4 pb-3 border-b border-border/50">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {issue.source?.name ?? "Unknown source"}
          {date ? ` · ${date}` : ""}
        </p>
        <h3 className="font-serif text-xl font-semibold leading-tight text-foreground text-balance line-clamp-4">
          {issue.title}
        </h3>
        <ul className="flex flex-wrap gap-1.5 pt-1">
          {issue.category && (
            <li>
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[11px]"
                title="Heuristic category"
              >
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: issue.category.color }}
                />
                {issue.category.name}
              </span>
            </li>
          )}
          {issue.llm_primary_tag && (
            <li>
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] text-foreground/80"
                title="LLM primary tag"
              >
                {issue.llm_primary_tag.replace(/_/g, " ")}
              </span>
            </li>
          )}
        </ul>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {snippet && (
          <DrawerSection title="Excerpt">
            <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
              {snippet}
            </p>
          </DrawerSection>
        )}

        <DrawerSection title="Signals" caption="impact · sentiment · frequency">
          <ul className="grid grid-cols-3 gap-2 text-center">
            <li className="rounded-md border border-border/60 bg-card p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Impact
              </p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {Number.isFinite(issue.impact_score) ? issue.impact_score.toFixed(1) : "—"}
              </p>
            </li>
            <li className="rounded-md border border-border/60 bg-card p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Sentiment
              </p>
              <p
                className={`mt-0.5 text-sm font-medium capitalize ${
                  issue.sentiment === "positive"
                    ? "text-emerald-600"
                    : issue.sentiment === "negative"
                      ? "text-red-600"
                      : "text-foreground"
                }`}
              >
                {issue.sentiment}
              </p>
            </li>
            <li className="rounded-md border border-border/60 bg-card p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Frequency
              </p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {issue.frequency_count}
              </p>
            </li>
          </ul>
        </DrawerSection>

        {issue.error_code && (
          <DrawerSection title="Error code">
            <code className="inline-block rounded bg-muted px-2 py-1 font-mono text-xs">
              {issue.error_code}
            </code>
          </DrawerSection>
        )}

        {clusterId && (
          <DrawerSection
            title="Similar from this cluster"
            caption={isLoading ? "loading…" : `${similarTrimmed.length} found`}
          >
            <IssueList
              issues={similarTrimmed}
              onSelect={(i) => onSelectIssue(i.id)}
              emptyHint={
                isLoading
                  ? "Loading…"
                  : "No other reports in this cluster yet — this issue is the only one."
              }
            />
          </DrawerSection>
        )}
      </div>

      <footer className="mt-auto flex flex-col gap-2 border-t border-border/50 bg-card/40 p-4">
        <Button asChild className="w-full justify-center gap-2">
          <a href={issue.url} target="_blank" rel="noreferrer">
            Open original
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
        {clusterId && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenCluster(clusterId)}
            className="w-full justify-center gap-2"
          >
            <Layers3 className="h-4 w-4" />
            Open this cluster
          </Button>
        )}
      </footer>
    </div>
  )
}
