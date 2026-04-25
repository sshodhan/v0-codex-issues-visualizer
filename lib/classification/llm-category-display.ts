// Display contract for the LLM category enum (taxonomy.ts CATEGORY_ENUM).
//
// The enum is a closed set of 12 values, so a fixed palette + label map
// is cheaper and more legible than deriving colors from the slug string.
// Stays in this module (not in taxonomy.ts) because taxonomy.ts is a
// data contract loaded by the OpenAI request builder under
// `--experimental-strip-types`, and pulling Tailwind classnames into
// that path would couple the prompt build to the design system.

import { CATEGORY_ENUM, type IssueCategory } from "./taxonomy"

export const LLM_CATEGORY_LABELS: Record<IssueCategory, string> = {
  "code-generation-quality": "Code generation",
  "hallucination": "Hallucination",
  "tool-use-failure": "Tool use",
  "context-handling": "Context handling",
  "latency-performance": "Latency / perf",
  "auth-session": "Auth / session",
  "cli-ux": "CLI UX",
  "install-env": "Install / env",
  "cost-quota": "Cost / quota",
  "safety-policy": "Safety / policy",
  "integration-mcp": "Integration / MCP",
  "other": "Other",
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
  "code-generation-quality": {
    bg: "bg-blue-500/12 hover:bg-blue-500/20",
    text: "text-blue-700 dark:text-blue-300",
    ring: "ring-blue-500/30",
  },
  "hallucination": {
    bg: "bg-purple-500/12 hover:bg-purple-500/20",
    text: "text-purple-700 dark:text-purple-300",
    ring: "ring-purple-500/30",
  },
  "tool-use-failure": {
    bg: "bg-orange-500/12 hover:bg-orange-500/20",
    text: "text-orange-700 dark:text-orange-300",
    ring: "ring-orange-500/30",
  },
  "context-handling": {
    bg: "bg-cyan-500/12 hover:bg-cyan-500/20",
    text: "text-cyan-700 dark:text-cyan-300",
    ring: "ring-cyan-500/30",
  },
  "latency-performance": {
    bg: "bg-amber-500/12 hover:bg-amber-500/20",
    text: "text-amber-700 dark:text-amber-300",
    ring: "ring-amber-500/30",
  },
  "auth-session": {
    bg: "bg-rose-500/12 hover:bg-rose-500/20",
    text: "text-rose-700 dark:text-rose-300",
    ring: "ring-rose-500/30",
  },
  "cli-ux": {
    bg: "bg-teal-500/12 hover:bg-teal-500/20",
    text: "text-teal-700 dark:text-teal-300",
    ring: "ring-teal-500/30",
  },
  "install-env": {
    bg: "bg-emerald-500/12 hover:bg-emerald-500/20",
    text: "text-emerald-700 dark:text-emerald-300",
    ring: "ring-emerald-500/30",
  },
  "cost-quota": {
    bg: "bg-yellow-500/15 hover:bg-yellow-500/25",
    text: "text-yellow-800 dark:text-yellow-300",
    ring: "ring-yellow-500/30",
  },
  "safety-policy": {
    bg: "bg-red-500/12 hover:bg-red-500/20",
    text: "text-red-700 dark:text-red-300",
    ring: "ring-red-500/30",
  },
  "integration-mcp": {
    bg: "bg-indigo-500/12 hover:bg-indigo-500/20",
    text: "text-indigo-700 dark:text-indigo-300",
    ring: "ring-indigo-500/30",
  },
  "other": {
    bg: "bg-slate-500/12 hover:bg-slate-500/20",
    text: "text-slate-700 dark:text-slate-300",
    ring: "ring-slate-500/30",
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
