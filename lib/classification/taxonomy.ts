export const CATEGORY_ENUM = [
  "code-generation-quality",
  "hallucination",
  "tool-use-failure",
  "context-handling",
  "latency-performance",
  "auth-session",
  "cli-ux",
  "install-env",
  "cost-quota",
  "safety-policy",
  "integration-mcp",
  "other",
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
