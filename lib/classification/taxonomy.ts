// LLM `category` enum — fixed strict-schema field produced by
// the OpenAI classifier (lib/classification/schema.ts). Surfaced in the
// UI as "LLM category" (e.g. the Hero card classification cloud).
// Deliberately disjoint from the heuristic `categories` SQL table
// (Bug, Feature Request, Performance, UX/UI, …) which is surfaced as
// "Topic". Renaming this field would cascade through the JSON schema,
// the prompt, the DB column, the materialized view, and every API
// consumer — kept as-is on purpose. See docs/ARCHITECTURE.md §6.0 —
// Glossary.
export const CATEGORY_ENUM = [
  "incomplete_context_overflow",
  "structural_dependency_oversight",
  "tool_invocation_error",
  "dependency_environment_failure",
  "code_generation_bug",
  "hallucinated_code",
  "retrieval_context_mismatch",
  "user_intent_misinterpretation",
  "autonomy_safety_violation",
  "performance_latency_issue",
  "cost_quota_overrun",
  "session_auth_error",
  "cli_user_experience_bug",
  "integration_plugin_failure",
] as const

export const SEVERITY_ENUM = ["critical", "high", "medium", "low"] as const

export const STATUS_ENUM = ["new", "triaged", "in-progress", "resolved", "wont-fix", "duplicate"] as const

export const REPRODUCIBILITY_ENUM = ["always", "often", "sometimes", "once", "unknown"] as const

export const IMPACT_ENUM = ["single-user", "team", "org", "fleet", "unknown"] as const

export type IssueCategory = (typeof CATEGORY_ENUM)[number]
export type Severity = (typeof SEVERITY_ENUM)[number]
export type IssueStatus = (typeof STATUS_ENUM)[number]
export type Reproducibility = (typeof REPRODUCIBILITY_ENUM)[number]
export type Impact = (typeof IMPACT_ENUM)[number]
