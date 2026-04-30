// Display contract for the LLM category enum (taxonomy.ts CATEGORY_ENUM).
//
// The enum is a closed set of stable values, so a fixed palette + label map
// is cheaper and more legible than deriving colors from the slug string.
// Stays in this module (not in taxonomy.ts) because taxonomy.ts is a
// data contract loaded by the OpenAI request builder under
// `--experimental-strip-types`, and pulling Tailwind classnames into
// that path would couple the prompt build to the design system.

import type { IssueCategory, IssueStatus, Severity } from "./taxonomy.ts"

export const LLM_CATEGORY_LABELS: Record<IssueCategory, string> = {
  incomplete_context_overflow: "Incomplete context / overflow",
  structural_dependency_oversight: "Structural dependency oversight",
  tool_invocation_error: "Tool invocation error",
  dependency_environment_failure: "Dependency / environment failure",
  code_generation_bug: "Code generation bug",
  hallucinated_code: "Hallucinated code",
  retrieval_context_mismatch: "Retrieval context mismatch",
  user_intent_misinterpretation: "User intent misinterpretation",
  autonomy_safety_violation: "Autonomy / safety violation",
  performance_latency_issue: "Performance / latency issue",
  cost_quota_overrun: "Cost / quota overrun",
  session_auth_error: "Session / auth error",
  cli_user_experience_bug: "CLI / UX bug",
  integration_plugin_failure: "Integration / plugin failure",
}

export const LLM_SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
}

export const LLM_STATUS_LABELS: Record<IssueStatus, string> = {
  new: "New",
  triaged: "Triaged",
  "in-progress": "In progress",
  resolved: "Resolved",
  "wont-fix": "Won't fix",
  duplicate: "Duplicate",
}

export function llmSeverityLabel(slug: string | null | undefined): string {
  if (!slug) return "—"
  return LLM_SEVERITY_LABELS[slug as Severity] ?? slug
}

export function llmStatusLabel(slug: string | null | undefined): string {
  if (!slug) return "—"
  return LLM_STATUS_LABELS[slug as IssueStatus] ?? slug
}

export interface LlmCategoryPalette {
  /** Pill background (low-contrast tint, works on light + dark). */
  bg: string
  /** Pill text. */
  text: string
  /** Hover ring + focus ring. */
  ring: string
}

const LLM_CATEGORY_PALETTE: Record<IssueCategory, LlmCategoryPalette> = {
  incomplete_context_overflow: {
    bg: "bg-cyan-500/12 hover:bg-cyan-500/20",
    text: "text-cyan-700 dark:text-cyan-300",
    ring: "ring-cyan-500/30",
  },
  structural_dependency_oversight: {
    bg: "bg-sky-500/12 hover:bg-sky-500/20",
    text: "text-sky-700 dark:text-sky-300",
    ring: "ring-sky-500/30",
  },
  tool_invocation_error: {
    bg: "bg-orange-500/12 hover:bg-orange-500/20",
    text: "text-orange-700 dark:text-orange-300",
    ring: "ring-orange-500/30",
  },
  dependency_environment_failure: {
    bg: "bg-emerald-500/12 hover:bg-emerald-500/20",
    text: "text-emerald-700 dark:text-emerald-300",
    ring: "ring-emerald-500/30",
  },
  code_generation_bug: {
    bg: "bg-blue-500/12 hover:bg-blue-500/20",
    text: "text-blue-700 dark:text-blue-300",
    ring: "ring-blue-500/30",
  },
  hallucinated_code: {
    bg: "bg-purple-500/12 hover:bg-purple-500/20",
    text: "text-purple-700 dark:text-purple-300",
    ring: "ring-purple-500/30",
  },
  retrieval_context_mismatch: {
    bg: "bg-violet-500/12 hover:bg-violet-500/20",
    text: "text-violet-700 dark:text-violet-300",
    ring: "ring-violet-500/30",
  },
  user_intent_misinterpretation: {
    bg: "bg-fuchsia-500/12 hover:bg-fuchsia-500/20",
    text: "text-fuchsia-700 dark:text-fuchsia-300",
    ring: "ring-fuchsia-500/30",
  },
  autonomy_safety_violation: {
    bg: "bg-red-500/12 hover:bg-red-500/20",
    text: "text-red-700 dark:text-red-300",
    ring: "ring-red-500/30",
  },
  performance_latency_issue: {
    bg: "bg-amber-500/12 hover:bg-amber-500/20",
    text: "text-amber-700 dark:text-amber-300",
    ring: "ring-amber-500/30",
  },
  cost_quota_overrun: {
    bg: "bg-yellow-500/15 hover:bg-yellow-500/25",
    text: "text-yellow-800 dark:text-yellow-300",
    ring: "ring-yellow-500/30",
  },
  session_auth_error: {
    bg: "bg-rose-500/12 hover:bg-rose-500/20",
    text: "text-rose-700 dark:text-rose-300",
    ring: "ring-rose-500/30",
  },
  cli_user_experience_bug: {
    bg: "bg-teal-500/12 hover:bg-teal-500/20",
    text: "text-teal-700 dark:text-teal-300",
    ring: "ring-teal-500/30",
  },
  integration_plugin_failure: {
    bg: "bg-indigo-500/12 hover:bg-indigo-500/20",
    text: "text-indigo-700 dark:text-indigo-300",
    ring: "ring-indigo-500/30",
  },
}

const FALLBACK_PALETTE: LlmCategoryPalette = {
  bg: "bg-muted hover:bg-muted/80",
  text: "text-muted-foreground",
  ring: "ring-border",
}

// Humanize a snake_case / kebab-case slug.
//   - "title" mode capitalizes every word ("Missing Dependency") — matches
//     how subcategories already render in the triage UI.
//   - "sentence" mode capitalizes the first word only ("Output content
//     safety") — matches the curated `LLM_CATEGORY_LABELS` style so the
//     fallback path is visually indistinguishable from a hand-tuned entry.
function humanizeSlug(slug: string, mode: "title" | "sentence" = "title"): string {
  const parts = slug.split(/[_-]+/).filter(Boolean)
  if (parts.length === 0) return slug
  if (mode === "sentence") {
    const [first, ...rest] = parts
    return [
      first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(),
      ...rest.map((p) => p.toLowerCase()),
    ].join(" ")
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
}

export function llmCategoryLabel(slug: string): string {
  // Prefer the curated label, fall back to a sentence-cased humanization.
  // The CATEGORY_ENUM membership check is intentionally absent: slugs land
  // in CATEGORY_ENUM before their curated label entry catches up (the
  // `output_content_safety` case from PR #125), and we'd rather return a
  // readable fallback than `undefined` from a missing map key.
  const curated = LLM_CATEGORY_LABELS[slug as IssueCategory] as string | undefined
  if (curated) return curated
  return slug ? humanizeSlug(slug, "sentence") : slug
}

export function llmCategoryPalette(slug: string): LlmCategoryPalette {
  // Same enum-membership-isn't-enough story as llmCategoryLabel above —
  // an enum value with no palette entry must still resolve to a real
  // palette object, not undefined.
  const curated = LLM_CATEGORY_PALETTE[slug as IssueCategory] as LlmCategoryPalette | undefined
  return curated ?? FALLBACK_PALETTE
}

// Subcategory is open-ended (LLM-coined snake_case per the prompt
// schema), so there's no enum-driven label map. Format defensively and
// fall back to "General" when absent — matches the "General" sentinel
// used as the raw-slug placeholder in `triageGroupParts` below.
export function formatSubcategoryLabel(subcategory: string | null | undefined): string {
  if (!subcategory) return "General"
  return humanizeSlug(subcategory)
}

export interface TriageGroupParts {
  /** Stable raw key — `category › subcategory` slug — used for grouping, filtering, and as the React key. Never localized. */
  raw: string
  /** Human-friendly `Category › Subcategory` for display only. */
  label: string
  /** Raw category slug, exposed so the caller can build slug-only tooltips. */
  rawCategory: string
  /**
   * Raw subcategory slug, or the literal "General" sentinel when the
   * record has no subcategory. Callers showing this in a "raw slug"
   * tooltip should map "General" back to a placeholder like "(none)" —
   * the sentinel is for grouping/equality, not for reviewer display.
   */
  rawSubcategory: string
}

export function triageGroupParts(input: {
  category: string
  subcategory: string | null | undefined
}): TriageGroupParts {
  const rawCategory = input.category
  const rawSubcategory = input.subcategory || "General"
  return {
    raw: `${rawCategory} › ${rawSubcategory}`,
    label: `${llmCategoryLabel(rawCategory)} › ${formatSubcategoryLabel(input.subcategory)}`,
    rawCategory,
    rawSubcategory,
  }
}

/**
 * Truth-faithful slug rendering for a triage group's "Slug:" tooltip:
 * drops the "General" sentinel when the record has no real subcategory
 * slug, so the tooltip never claims a placeholder is a slug. Pair with
 * a "Slug: " prefix at the call site.
 *
 *   formatTriageGroupSlug("code_generation_bug", "syntax_error")
 *     // "code_generation_bug › syntax_error"
 *   formatTriageGroupSlug("tool_invocation_error", "General")
 *     // "tool_invocation_error (no subcategory)"
 */
export function formatTriageGroupSlug(rawCategory: string, rawSubcategory: string): string {
  if (rawSubcategory === "General") {
    return `${rawCategory} (no subcategory)`
  }
  return `${rawCategory} › ${rawSubcategory}`
}
