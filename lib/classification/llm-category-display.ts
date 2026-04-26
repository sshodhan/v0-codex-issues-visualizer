// Display contract for the LLM category enum (taxonomy.ts CATEGORY_ENUM).
//
// The enum is a closed set of stable values, so a fixed palette + label map
// is cheaper and more legible than deriving colors from the slug string.
// Stays in this module (not in taxonomy.ts) because taxonomy.ts is a
// data contract loaded by the OpenAI request builder under
// `--experimental-strip-types`, and pulling Tailwind classnames into
// that path would couple the prompt build to the design system.

import { CATEGORY_ENUM, type IssueCategory } from "./taxonomy"

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

export function llmCategoryLabel(slug: string): string {
  if ((CATEGORY_ENUM as readonly string[]).includes(slug)) {
    return LLM_CATEGORY_LABELS[slug as IssueCategory]
  }
  return slug
}

export function llmCategoryPalette(slug: string): LlmCategoryPalette {
  if ((CATEGORY_ENUM as readonly string[]).includes(slug)) {
    return LLM_CATEGORY_PALETTE[slug as IssueCategory]
  }
  return FALLBACK_PALETTE
}
