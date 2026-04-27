/**
 * Drawer state for the Story tab. Single source of truth for "what is the user exploring";
 * every story-tab visualization (atlas, timeline, cluster list) opens or closes this.
 *
 * Selection is *separate from* the global dashboard filter on purpose. Opening a drawer is
 * exploration. Committing to "use as page filter" inside the drawer is what mutates the
 * existing global filter — so users can preview without re-rendering the whole page.
 */
export type StoryDrawerTarget =
  | { kind: "heuristic"; slug: string; label: string; color?: string }
  | { kind: "llm"; slug: string; label: string; color?: string }
  | { kind: "cluster"; clusterId: string }
  | { kind: "issue"; issueId: string }
  | null

export type StoryHighlight = NonNullable<StoryDrawerTarget>
