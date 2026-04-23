// Pipeline prerequisite status types + decision tree for the AI triage
// tab's empty-state panel. Kept in plain .ts (no JSX) so node --test can
// import it directly under `--experimental-strip-types`; the React
// component at components/dashboard/classification-triage.tsx re-uses
// the same types and helper.
//
// See docs/CLUSTERING_DESIGN.md §7 for the UI behaviour this powers, and
// app/api/classifications/stats/route.ts for the server-side source of
// the status numbers.

export interface PrerequisiteStatus {
  observationsInWindow: number
  classifiedCount: number
  clusteredCount: number
  pendingClassification: number
  pendingClustering: number
  openaiConfigured: boolean
  lastScrape: { at: string | null; status: string | null }
  lastClassifyBackfill: { at: string | null; status: string | null }
}

export type PrereqCta =
  | { kind: "none" }
  | { kind: "openai-missing" }
  | { kind: "classify-backfill"; href: string; label: string }
  | { kind: "clustering"; href: string; label: string }

// Decides which "do this next" CTA the pipeline-empty panel should
// surface. Precedence is deliberate:
//   1. No observations → there's nothing downstream to fix; the fix is
//      upstream (wait for scrape, or check cron). No CTA into admin
//      tabs that would run against an empty set.
//   2. Missing OpenAI key → the classify-backfill endpoint returns 503
//      in this state (app/api/admin/classify-backfill/route.ts) and
//      cluster labels won't generate. Surface a warning, suppress the
//      click-through so reviewers don't think the button is the fix.
//   3. Pending classification is the most common blocker — runs on top
//      of existing clustering, and its admin panel is the main entry
//      point. Secondary clustering CTA is rendered separately by the
//      panel when both are behind.
//   4. Pending clustering with classification caught up is unusual but
//      possible (classify-backfill can widen the set before clustering
//      catches up on a later scrape); link to the clustering admin
//      tab.
//   5. Everything caught up → no CTA; panel should not render at all
//      in this state, but the helper returns `none` defensively.
export function pickPrimaryCta(prereq: PrerequisiteStatus): PrereqCta {
  if (prereq.observationsInWindow === 0) return { kind: "none" }
  if (!prereq.openaiConfigured) return { kind: "openai-missing" }
  if (prereq.pendingClassification > 0) {
    return {
      kind: "classify-backfill",
      href: "/admin?tab=classify-backfill",
      label: "Run classify-backfill",
    }
  }
  if (prereq.pendingClustering > 0) {
    return {
      kind: "clustering",
      href: "/admin?tab=clustering",
      label: "Rebuild clustering",
    }
  }
  return { kind: "none" }
}
