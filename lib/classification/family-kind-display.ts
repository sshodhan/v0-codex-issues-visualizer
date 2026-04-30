// Display contract for FamilyKind (lib/storage/family-classification.ts).
//
// Mirrors the lib/classification/llm-category-display.ts pattern: keep
// the curated labels in a small client-safe module so any UI surface
// (admin panel, trace page, future cluster summary card) renders the
// same human strings without each callsite re-coining its own map.

import type { FamilyKind } from "@/lib/storage/family-classification"

export const FAMILY_KIND_LABELS: Record<FamilyKind, string> = {
  coherent_single_issue: "Coherent",
  mixed_multi_causal: "Mixed (multi-causal)",
  needs_split_review: "Needs split review",
  low_evidence: "Low evidence",
  unclear: "Unclear",
}

export function familyKindLabel(slug: string | null | undefined): string {
  if (!slug) return "—"
  return FAMILY_KIND_LABELS[slug as FamilyKind] ?? slug
}
