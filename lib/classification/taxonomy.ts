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
  "output_content_safety",
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

// Per-category definitions rendered into lib/classification/prompt.ts as the
// TAXONOMY block. The Record<IssueCategory, …> shape forces the keys to stay
// in lockstep with CATEGORY_ENUM at build time; tests/classifier-prompt.test.ts
// asserts every category has a definition with non-empty fields.
//
// Field semantics:
//   one_liner: definition shown to the model (≤ 1 sentence).
//   pick_when: concrete signals in the input that select this category.
//   not_when:  the closest-confusion category and how to disambiguate.
export interface CategoryDefinition {
  one_liner: string
  pick_when: readonly string[]
  not_when: readonly string[]
}

export const CATEGORY_DEFINITIONS: Record<IssueCategory, CategoryDefinition> = {
  incomplete_context_overflow: {
    one_liner:
      "The agent ran out of usable context window or truncated necessary input mid-task.",
    pick_when: [
      "context window exceeded",
      "earlier file or turn dropped before answer",
      "summary lost a critical detail",
      "auto-compact failed near the limit",
    ],
    not_when: [
      "the right material was available but wrong file was selected (use retrieval_context_mismatch)",
      "the user request was misread (use user_intent_misinterpretation)",
    ],
  },
  retrieval_context_mismatch: {
    one_liner:
      "The agent retrieved or selected the wrong file, doc, snippet, or memory and acted on it; the right material was available.",
    pick_when: [
      "wrong file pulled into context",
      "RAG returned irrelevant chunk",
      "stale doc surfaced over a current one",
      "similar-symbol confusion led to editing the wrong target",
    ],
    not_when: [
      "context window simply ran out (use incomplete_context_overflow)",
      "the symbol did not exist anywhere (use hallucinated_code)",
    ],
  },
  structural_dependency_oversight: {
    one_liner:
      "Generated code does not account for an existing project dependency, type, interface, schema, or contract.",
    pick_when: [
      "forgot to update a caller",
      "missed an existing type or schema contract",
      "broke build because callers rely on the changed shape",
      "missed a layer or module boundary",
    ],
    not_when: [
      "code logic itself is wrong on its own terms (use code_generation_bug)",
    ],
  },
  code_generation_bug: {
    one_liner:
      "The generated code's logic is wrong on its own terms, independent of project structure.",
    pick_when: [
      "off-by-one",
      "wrong API call shape",
      "incorrect control flow",
      "edge case missed inside the generated function",
    ],
    not_when: [
      "code missed a project-specific dependency or contract (use structural_dependency_oversight)",
      "the code calls a symbol that does not exist (use hallucinated_code)",
    ],
  },
  tool_invocation_error: {
    one_liner:
      "An attempted tool, CLI, API, or MCP call was constructed wrong, failed, timed out, or returned malformed data.",
    pick_when: [
      "shell command exited nonzero",
      "API call returned 4xx or 5xx",
      "MCP call timed out or returned invalid payload",
      "git or file operation errored",
    ],
    not_when: [
      "the third-party plugin's surface itself is broken regardless of the call (use integration_plugin_failure)",
      "no tool was called and the generated code is just wrong (use code_generation_bug)",
      "the tool succeeded but its output was misread by the model (use user_intent_misinterpretation)",
    ],
  },
  integration_plugin_failure: {
    one_liner:
      "A specific third-party plugin, IDE, or MCP server's behavior is wrong regardless of how the agent calls it.",
    pick_when: [
      "VS Code extension misbehaves under valid inputs",
      "named MCP server returns garbage even on a known-good call",
      "JetBrains/Cursor plugin loses state on a defined trigger",
    ],
    not_when: [
      "the agent constructed the call incorrectly (use tool_invocation_error)",
      "the user's environment broke the plugin (use dependency_environment_failure)",
    ],
  },
  dependency_environment_failure: {
    one_liner:
      "The user's environment, install, runtime, or dependency setup blocked the task.",
    pick_when: [
      "missing system binary",
      "wrong node/python/runtime version",
      "package resolution failure",
      "platform-specific permission denied",
    ],
    not_when: [
      "the CLI's own UX caused confusion (use cli_user_experience_bug)",
      "the plugin itself is broken (use integration_plugin_failure)",
    ],
  },
  hallucinated_code: {
    one_liner:
      "The model fabricated a symbol, file path, API, flag, error string, or behavior that does not exist anywhere.",
    pick_when: [
      "calls a non-existent function or method",
      "imports a fake module",
      "invents a CLI flag or config key",
      "fabricates an error message that was never emitted",
    ],
    not_when: [
      "the symbol exists but the wrong one was retrieved (use retrieval_context_mismatch)",
      "model misread what the user asked (use user_intent_misinterpretation)",
    ],
  },
  user_intent_misinterpretation: {
    one_liner:
      "The model misunderstood what the user asked for, including misreading correct tool output.",
    pick_when: [
      "solved the wrong problem",
      "ignored a stated constraint",
      "answered a different question",
      "tool succeeded but model summarized its result incorrectly",
    ],
    not_when: [
      "model invented something not in the world (use hallucinated_code)",
    ],
  },
  autonomy_safety_violation: {
    one_liner:
      "The agent took or proposed an action that exceeds safety/autonomy bounds: data loss, destructive ops, secret exposure, unauthorized writes, billing impact.",
    pick_when: [
      "rm -rf or destructive command without confirmation",
      "force-pushed without permission",
      "leaked or printed a secret/credential",
      "ran a billing- or production-affecting operation unprompted",
    ],
    not_when: [
      "non-destructive functional bug (use code_generation_bug or the relevant category)",
      "model emitted unsafe content in its output without taking an action (use output_content_safety)",
    ],
  },
  output_content_safety: {
    one_liner:
      "The model emitted unsafe, inappropriate, sensitive, or off-policy content in its output. Distinct from autonomy_safety_violation, which covers unsafe agent actions; this category covers what the model says, not what it does.",
    pick_when: [
      "adult / violent / hateful / illegal content surfaced in output",
      "PII or secret leaked into model-generated text (regurgitation, not the agent printing a known secret)",
      "verbatim training-data memorization appeared in output",
      "user prompt-injection succeeded and produced off-policy content",
      "model engaged with a topic it should have refused",
    ],
    not_when: [
      "the agent took an unsafe action like rm -rf or printed a known credential it had access to (use autonomy_safety_violation)",
      "the model fabricated a code symbol or API that does not exist (use hallucinated_code)",
      "the output was merely formatted wrong but content was on-policy (use user_intent_misinterpretation)",
    ],
  },
  performance_latency_issue: {
    one_liner:
      "The agent or its output was unacceptably slow but not functionally wrong.",
    pick_when: [
      "multi-minute response on a small task",
      "tool-call retry loop without progress",
      "generated code is functionally correct but slow at runtime",
    ],
    not_when: [
      "a timeout caused a tool to fail (use tool_invocation_error)",
    ],
  },
  cost_quota_overrun: {
    one_liner:
      "Token, request, or money budget exceeded; quota or rate-limit hit.",
    pick_when: [
      "unexpectedly expensive run",
      "rate-limited mid-session",
      "quota exhausted",
      "model escalation pushed cost over budget",
    ],
    not_when: [
      "auth credentials failed (use session_auth_error)",
    ],
  },
  session_auth_error: {
    one_liner:
      "Authentication, session, login, or token problem.",
    pick_when: [
      "sign-in loop",
      "expired or rejected token",
      "OAuth callback fails",
      "permission scope missing",
    ],
    not_when: [
      "quota issue (use cost_quota_overrun)",
    ],
  },
  cli_user_experience_bug: {
    one_liner:
      "The CLI/TUI itself has a UX bug: confusing flag, broken progress feedback, misformatted output, unclear error.",
    pick_when: [
      "help text wrong or misleading",
      "flag silently ignored",
      "TUI misrenders or shifts under interaction",
      "install/setup instructions unclear",
    ],
    not_when: [
      "environment caused failure (use dependency_environment_failure)",
      "the underlying tool call failed (use tool_invocation_error)",
    ],
  },
}

// Per-category seed list of stable subcategory slugs. Rendered into the
// SUBCATEGORY GUIDANCE block of lib/classification/prompt.ts. The model is
// told to reuse these exact spellings when one fits, and to coin a new
// snake_case slug only when none do. Closed-ish set: shrinks subcategory
// cardinality so the dashboard's (effective_category, subcategory) triage
// groups stay meaningful, while preserving room for new mechanisms.
export const SUBCATEGORY_EXAMPLES: Record<IssueCategory, readonly string[]> = {
  incomplete_context_overflow: [
    "context_window_overflow",
    "missing_file_context",
    "truncated_conversation",
    "lost_prior_instruction",
    "large_repo_navigation_failure",
  ],
  structural_dependency_oversight: [
    "missed_cross_file_dependency",
    "missed_call_site_update",
    "missed_schema_contract",
    "missed_test_update",
    "layer_boundary_violation",
  ],
  tool_invocation_error: [
    "shell_command_failed",
    "tool_timeout",
    "mcp_call_failed",
    "file_read_write_failed",
    "git_operation_failed",
  ],
  dependency_environment_failure: [
    "missing_dependency",
    "version_mismatch",
    "package_resolution_failure",
    "runtime_not_available",
    "platform_specific_failure",
    "permission_denied",
  ],
  code_generation_bug: [
    "syntax_error",
    "type_error",
    "logic_bug",
    "api_misuse",
    "state_management_bug",
    "edge_case_missing",
  ],
  hallucinated_code: [
    "nonexistent_api",
    "imaginary_file_path",
    "invented_config_option",
    "fabricated_error_message",
    "unsupported_library_usage",
  ],
  retrieval_context_mismatch: [
    "wrong_file_retrieved",
    "stale_context_used",
    "irrelevant_search_result",
    "similar_symbol_confusion",
    "wrong_repo_area",
  ],
  user_intent_misinterpretation: [
    "wrong_task_scope",
    "ignored_constraint",
    "overbroad_change",
    "underimplemented_request",
    "wrong_output_format",
    "tool_output_misread",
  ],
  autonomy_safety_violation: [
    "destructive_action_attempted",
    "unsafe_command_suggested",
    "secret_exposure_risk",
    "unapproved_external_action",
  ],
  output_content_safety: [
    "unsafe_content_emitted",
    "pii_or_secret_in_output",
    "prompt_injection_succeeded",
    "training_data_leakage",
    "prohibited_topic_engaged",
  ],
  performance_latency_issue: [
    "slow_response",
    "tool_looping",
    "excessive_retries",
    "large_context_latency",
    "rate_limit_delay",
  ],
  cost_quota_overrun: [
    "quota_exceeded",
    "token_overuse",
    "excessive_tool_calls",
    "expensive_model_escalation",
    "billing_limit_hit",
  ],
  session_auth_error: [
    "login_loop",
    "token_expired",
    "oauth_failure",
    "session_lost",
    "permission_scope_missing",
  ],
  cli_user_experience_bug: [
    "unclear_error_message",
    "bad_progress_feedback",
    "confusing_prompt",
    "install_instructions_unclear",
    "command_flag_confusion",
  ],
  integration_plugin_failure: [
    "vscode_extension_failure",
    "cursor_integration_failure",
    "jetbrains_plugin_failure",
    "mcp_integration_failure",
    "github_integration_failure",
    "ci_integration_failure",
  ],
}
