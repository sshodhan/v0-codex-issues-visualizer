"""Canonical Codex market-analysis dataset.

Every number the frontend renders originates here. The SQL migration
(`scripts/003_create_analysis_schema.sql`) and the JSON fixture
(`scripts/003_seed_data.json`) are derived from this module and MUST
stay in sync.

Source: the Codex Market Analysis brief (Jan 2025 – Apr 2026 crisis arc).
"""

from __future__ import annotations

from typing import Any


# Categories with TIER classification per the brief. `share_pct` is the
# share of issues touching this category (multi-label; sums >100). Tier
# drives prioritization: TIER 1 = critical cascading issues, TIER 2 =
# persistent quality problems, TIER 3 = symptomatic / operational.
CATEGORIES: list[dict[str, Any]] = [
    {
        "id": "cat-session-memory",
        "name": "Session / Memory Management",
        "slug": "session-memory",
        "color": "#ef4444",
        "tier": 1,
        "share_pct": 29.0,
        "users_affected_pct": 12.0,
        "summary": "Recursive context compaction and memory leaks during long sessions.",
        "cascades_to": [],
        "action": "Highest priority — fixes 2+ cascading issues.",
    },
    {
        "id": "cat-token-counting",
        "name": "Token Counting Issues",
        "slug": "token-counting",
        "color": "#f97316",
        "tier": 1,
        "share_pct": 27.0,
        "users_affected_pct": 8.0,
        "summary": "Off-by-one error in tokenizer.py driving phantom billing and early quota exhaustion.",
        "cascades_to": ["cat-context-overflow"],
        "action": "Fixes Context Overflow cascade (80% of affected users).",
    },
    {
        "id": "cat-context-overflow",
        "name": "Context Overflow",
        "slug": "context-overflow",
        "color": "#eab308",
        "tier": 1,
        "share_pct": 25.0,
        "users_affected_pct": 9.0,
        "summary": "Silent tail truncation; symptom of token-counting drift.",
        "cascades_to": [],
        "action": "Will largely resolve once Token Counting is fixed.",
    },
    {
        "id": "cat-code-review",
        "name": "Code Review Incomplete",
        "slug": "code-review-incomplete",
        "color": "#8b5cf6",
        "tier": 2,
        "share_pct": 22.0,
        "users_affected_pct": 7.0,
        "summary": "Persistent quality issue — model degradation at v1.8.0 dropping large-diff coverage.",
        "cascades_to": [],
        "action": "Pre-dates the crisis; needs dedicated model/eval workstream.",
    },
    {
        "id": "cat-regression-quality",
        "name": "Regression in Output Quality",
        "slug": "regression-quality",
        "color": "#ec4899",
        "tier": 2,
        "share_pct": 20.0,
        "users_affected_pct": 6.0,
        "summary": "Secondary quality degradation surfacing in agent outputs.",
        "cascades_to": [],
        "action": "Track against model release cadence; add automated regression evals.",
    },
    {
        "id": "cat-unexpected-behavior",
        "name": "Unexpected Behavior",
        "slug": "unexpected-behavior",
        "color": "#6b7280",
        "tier": 3,
        "share_pct": 18.0,
        "users_affected_pct": 4.0,
        "summary": "Symptom category that masks underlying issues; slowest recovery curve.",
        "cascades_to": [],
        "action": "Root-cause triage — likely resolves alongside TIER 1 fixes.",
    },
    {
        "id": "cat-api-rate-limit",
        "name": "API Rate Limiting",
        "slug": "api-rate-limiting",
        "color": "#3b82f6",
        "tier": 3,
        "share_pct": 18.0,
        "users_affected_pct": 3.0,
        "summary": "Operational/config issue with highest sentiment (38); low user count but drove 92% enterprise cost impact.",
        "cascades_to": [],
        "action": "Quick win — ship retry/backoff fix + quota dashboards.",
    },
]


USER_SEGMENTS: list[dict[str, Any]] = [
    {
        "id": "seg-enterprise",
        "name": "Enterprise",
        "slug": "enterprise",
        "description": "Organizations with 1000+ developers using Codex at scale.",
        "developer_count_range": "1000+",
        "crisis_severity_percentage": 78.0,
        "cost_impact_percentage": 92.0,
        "recovery_speed_percentage": 45.0,
    },
    {
        "id": "seg-professional",
        "name": "Professional Teams",
        "slug": "professional",
        "description": "Mid-market engineering orgs (50–999 developers).",
        "developer_count_range": "50-999",
        "crisis_severity_percentage": 65.0,
        "cost_impact_percentage": 78.0,
        "recovery_speed_percentage": 45.0,
    },
    {
        "id": "seg-smb",
        "name": "SMB",
        "slug": "smb",
        "description": "Small businesses and startups (5–49 developers).",
        "developer_count_range": "5-49",
        "crisis_severity_percentage": 42.0,
        "cost_impact_percentage": 55.0,
        "recovery_speed_percentage": 60.0,
    },
    {
        "id": "seg-ai-ml",
        "name": "AI / ML Teams",
        "slug": "ai-ml",
        "description": "Research and ML engineering teams across org sizes.",
        "developer_count_range": "varied",
        "crisis_severity_percentage": 55.0,
        "cost_impact_percentage": 68.0,
        "recovery_speed_percentage": 50.0,
    },
    {
        "id": "seg-indie",
        "name": "Indie Developers",
        "slug": "indie",
        "description": "Solo developers, freelancers, and hobbyists.",
        "developer_count_range": "1-4",
        "crisis_severity_percentage": 15.0,
        "cost_impact_percentage": 22.0,
        "recovery_speed_percentage": 85.0,
    },
]


ROOT_CAUSES: list[dict[str, Any]] = [
    {
        "id": "rc-compact-rs",
        "product": "codex",
        "title": "Recursive context compaction in compact.rs",
        "description": "compact.rs re-entered compaction during summary generation, producing an O(n^2) explosion that blew past context limits and silently dropped work.",
        "component": "codex-rs/core/src/codex/compact.rs",
        "error_type": "recursive_context_compaction",
        "severity": "critical",
        "first_detected": "2025-09-12",
        "identified_date": "2025-10-19",
        "fixed_date": "2025-11-04",
        "fixed_in_version": "v0.56",
        "estimated_users_impacted_percentage": 12.0,
        "affected_issue_ids": ["iss-001", "iss-004", "iss-009", "iss-013"],
    },
    {
        "id": "rc-memory-alloc",
        "product": "codex",
        "title": "Memory allocation failure under load",
        "description": "Worker pool exhausted heap when more than ~40 concurrent agents held large contexts; OOM killed in-flight completions without surfacing errors.",
        "component": "codex-rs/core/src/runtime/pool.rs",
        "error_type": "oom_silent_fail",
        "severity": "critical",
        "first_detected": "2025-08-24",
        "identified_date": "2025-10-02",
        "fixed_date": "2025-12-11",
        "fixed_in_version": "v0.58",
        "estimated_users_impacted_percentage": 8.0,
        "affected_issue_ids": ["iss-002", "iss-011"],
    },
    {
        "id": "rc-token-count",
        "product": "codex",
        "title": "Token counting inconsistency across tokenizers",
        "description": "Pricing meter used a different tokenizer than the model runtime, so users were billed for phantom tokens and hit quota early.",
        "component": "codex-rs/core/src/billing/meter.rs",
        "error_type": "tokenizer_mismatch",
        "severity": "high",
        "first_detected": "2025-07-30",
        "identified_date": "2025-09-18",
        "fixed_date": "2025-11-22",
        "fixed_in_version": "v0.57",
        "estimated_users_impacted_percentage": 5.0,
        "affected_issue_ids": ["iss-003", "iss-010"],
    },
    {
        "id": "rc-code-review-truncate",
        "product": "codex",
        "title": "Code review incomplete on large diffs",
        "description": "Reviewer dropped hunks silently past ~2k LOC because the prompt builder trimmed without notice.",
        "component": "codex-rs/core/src/reviewer/prompt.rs",
        "error_type": "silent_prompt_trim",
        "severity": "high",
        "first_detected": "2025-06-18",
        "identified_date": "2025-10-11",
        "fixed_date": "2026-01-20",
        "fixed_in_version": "v0.61",
        "estimated_users_impacted_percentage": 9.0,
        "affected_issue_ids": ["iss-005", "iss-014"],
    },
    {
        "id": "rc-session-reconnect",
        "product": "codex",
        "title": "Session state corruption on reconnect",
        "description": "Reconnecting clients lost message history order; downstream tool calls replayed out of sequence.",
        "component": "codex-rs/core/src/session/sync.rs",
        "error_type": "state_reorder",
        "severity": "high",
        "first_detected": "2025-07-05",
        "identified_date": "2025-10-28",
        "fixed_date": "2025-12-02",
        "fixed_in_version": "v0.57",
        "estimated_users_impacted_percentage": 7.0,
        "affected_issue_ids": ["iss-006", "iss-012"],
    },
    {
        "id": "rc-context-overflow",
        "product": "codex",
        "title": "Context overflow silent truncation",
        "description": "When the prompt crossed the model window, the tail was dropped before the instruction footer, leaving agents acting on stale instructions.",
        "component": "codex-rs/core/src/prompt/assemble.rs",
        "error_type": "tail_truncation",
        "severity": "medium",
        "first_detected": "2025-08-02",
        "identified_date": "2025-10-05",
        "fixed_date": "2025-12-18",
        "fixed_in_version": "v0.58",
        "estimated_users_impacted_percentage": 6.0,
        "affected_issue_ids": ["iss-007", "iss-015"],
    },
    {
        "id": "rc-rate-limit-parse",
        "product": "codex",
        "title": "Rate limit header parsing regression",
        "description": "Retry logic misread the X-RateLimit-Reset header as seconds instead of Unix timestamp, causing aggressive retries during throttling.",
        "component": "codex-rs/core/src/http/backoff.rs",
        "error_type": "header_parse",
        "severity": "medium",
        "first_detected": "2025-09-01",
        "identified_date": "2025-10-22",
        "fixed_date": "2025-11-14",
        "fixed_in_version": "v0.56",
        "estimated_users_impacted_percentage": 4.0,
        "affected_issue_ids": ["iss-008"],
    },
    {
        "id": "rc-ide-timeout",
        "product": "codex",
        "title": "IDE plugin timeout under latency spikes",
        "description": "VS Code extension hard-coded a 30s timeout that fired during slow model responses, aborting legitimate completions.",
        "component": "ide/vscode/src/client/transport.ts",
        "error_type": "client_timeout",
        "severity": "medium",
        "first_detected": "2025-10-10",
        "identified_date": "2025-11-01",
        "fixed_date": "2025-12-20",
        "fixed_in_version": "v0.59",
        "estimated_users_impacted_percentage": 3.0,
        "affected_issue_ids": ["iss-016"],
    },
    {
        "id": "rc-retry-storm",
        "product": "codex",
        "title": "Retry storm on transient upstream errors",
        "description": "502s from upstream caused unbounded client retries because jitter was disabled in the happy path.",
        "component": "codex-rs/core/src/http/retry.rs",
        "error_type": "retry_amplification",
        "severity": "medium",
        "first_detected": "2025-09-20",
        "identified_date": "2025-10-26",
        "fixed_date": "2025-12-05",
        "fixed_in_version": "v0.58",
        "estimated_users_impacted_percentage": 5.0,
        "affected_issue_ids": ["iss-004", "iss-011"],
    },
]


COMPETITIVE_DATA: list[dict[str, Any]] = [
    {
        "id": "comp-codex",
        "product": "codex",
        "display_name": "OpenAI Codex",
        "code_quality_score": 75.0,
        "efficiency_score": 90.0,
        "cost_per_task_usd": 15.0,
        "context_window_tokens": 200000,
        "agent_autonomy_score": 55.0,
        "market_sentiment": 0.25,
        "adoption_rate": 48.0,
        "enterprise_readiness_score": 62.0,
        "summary": "Strong context window and throughput. Weak agent autonomy; still recovering reputation post-crisis.",
    },
    {
        "id": "comp-claude-code",
        "product": "claude_code",
        "display_name": "Claude Code",
        "code_quality_score": 81.0,
        "efficiency_score": 25.0,
        "cost_per_task_usd": 155.0,
        "context_window_tokens": 1000000,
        "agent_autonomy_score": 92.0,
        "market_sentiment": 0.65,
        "adoption_rate": 32.0,
        "enterprise_readiness_score": 78.0,
        "summary": "Leader in agent autonomy and long-horizon tasks. Higher per-task cost; efficiency is the tradeoff.",
    },
    {
        "id": "comp-copilot",
        "product": "copilot",
        "display_name": "GitHub Copilot",
        "code_quality_score": 70.0,
        "efficiency_score": 60.0,
        "cost_per_task_usd": 30.0,
        "context_window_tokens": 128000,
        "agent_autonomy_score": 40.0,
        "market_sentiment": 0.40,
        "adoption_rate": 72.0,
        "enterprise_readiness_score": 70.0,
        "summary": "Balanced, widest footprint. Lagged in crisis response coverage and agent autonomy.",
    },
    {
        "id": "comp-gemini",
        "product": "gemini",
        "display_name": "Gemini Code Assist",
        "code_quality_score": 68.0,
        "efficiency_score": 70.0,
        "cost_per_task_usd": 20.0,
        "context_window_tokens": 2000000,
        "agent_autonomy_score": 45.0,
        "market_sentiment": 0.35,
        "adoption_rate": 28.0,
        "enterprise_readiness_score": 55.0,
        "summary": "Massive context window, price-competitive. Quality and autonomy still maturing.",
    },
]


ISSUES: list[dict[str, Any]] = [
    {
        "id": "iss-001",
        "source": "github_issue",
        "source_id": "openai/codex/12345",
        "product": "codex",
        "title": "Codex is rapidly degrading — tasks failing 66% of the time",
        "description": "Over the last 2 weeks my tasks have been failing. Large prompts silently truncate and the agent re-enters compaction until it gives up.",
        "url": "https://github.com/openai/codex/issues/12345",
        "category_id": "cat-context-overflow",
        "severity": "critical",
        "sentiment_score": -0.75,
        "engagement_score": 92.0,
        "mention_count": 47,
        "affected_segments": ["enterprise", "professional", "ai-ml"],
        "root_cause_id": "rc-compact-rs",
        "created_at": "2025-09-28T14:23:00Z",
    },
    {
        "id": "iss-002",
        "source": "github_issue",
        "source_id": "openai/codex/12488",
        "product": "codex",
        "title": "OOM kills under concurrent agents on larger contexts",
        "description": "Running >40 parallel sessions reliably crashes the worker pool without surfacing an error to the client.",
        "url": "https://github.com/openai/codex/issues/12488",
        "category_id": "cat-session-memory",
        "severity": "critical",
        "sentiment_score": -0.68,
        "engagement_score": 78.0,
        "mention_count": 22,
        "affected_segments": ["enterprise", "ai-ml"],
        "root_cause_id": "rc-memory-alloc",
        "created_at": "2025-09-10T09:02:00Z",
    },
    {
        "id": "iss-003",
        "source": "stackoverflow_question",
        "source_id": "so/79012345",
        "product": "codex",
        "title": "Why is my Codex token count double what the API returned?",
        "description": "The billing dashboard shows 2x the tokens my test harness counted using the SDK tokenizer.",
        "url": "https://stackoverflow.com/q/79012345",
        "category_id": "cat-token-counting",
        "severity": "high",
        "sentiment_score": -0.45,
        "engagement_score": 54.0,
        "mention_count": 18,
        "affected_segments": ["professional", "smb", "indie"],
        "root_cause_id": "rc-token-count",
        "created_at": "2025-08-14T12:40:00Z",
    },
    {
        "id": "iss-004",
        "source": "reddit_post",
        "source_id": "reddit/1n7rf2",
        "product": "codex",
        "title": "Anyone else seeing Codex retry-loop into a death spiral?",
        "description": "Every 502 from the upstream turns into dozens of retries in milliseconds. Blew our quota in an hour.",
        "url": "https://reddit.com/r/OpenAI/comments/1n7rf2",
        "category_id": "cat-api-rate-limit",
        "severity": "high",
        "sentiment_score": -0.62,
        "engagement_score": 66.0,
        "mention_count": 14,
        "affected_segments": ["professional", "smb"],
        "root_cause_id": "rc-retry-storm",
        "created_at": "2025-09-22T17:15:00Z",
    },
    {
        "id": "iss-005",
        "source": "github_issue",
        "source_id": "openai/codex/12612",
        "product": "codex",
        "title": "Review output cuts off halfway through long PRs",
        "description": "On PRs with >2k changed lines, Codex returns a review for the first few hunks and silently stops.",
        "url": "https://github.com/openai/codex/issues/12612",
        "category_id": "cat-code-review",
        "severity": "high",
        "sentiment_score": -0.55,
        "engagement_score": 71.0,
        "mention_count": 31,
        "affected_segments": ["enterprise", "professional"],
        "root_cause_id": "rc-code-review-truncate",
        "created_at": "2025-07-02T10:18:00Z",
    },
    {
        "id": "iss-006",
        "source": "github_discussion",
        "source_id": "openai/codex/disc/884",
        "product": "codex",
        "title": "Session history out-of-order after transient disconnect",
        "description": "After a reconnect the tool-call transcript replays events in the wrong order, so follow-ups operate on stale state.",
        "url": "https://github.com/openai/codex/discussions/884",
        "category_id": "cat-session-memory",
        "severity": "high",
        "sentiment_score": -0.50,
        "engagement_score": 48.0,
        "mention_count": 9,
        "affected_segments": ["enterprise", "ai-ml"],
        "root_cause_id": "rc-session-reconnect",
        "created_at": "2025-08-08T07:55:00Z",
    },
    {
        "id": "iss-007",
        "source": "hackernews",
        "source_id": "hn/41234567",
        "product": "codex",
        "title": "Codex silently drops the system prompt on long inputs",
        "description": "We traced a pattern where the model ignored the instruction footer once the prompt exceeded the context window — tail truncation with no warning.",
        "url": "https://news.ycombinator.com/item?id=41234567",
        "category_id": "cat-context-overflow",
        "severity": "medium",
        "sentiment_score": -0.42,
        "engagement_score": 59.0,
        "mention_count": 12,
        "affected_segments": ["professional", "ai-ml"],
        "root_cause_id": "rc-context-overflow",
        "created_at": "2025-08-19T21:00:00Z",
    },
    {
        "id": "iss-008",
        "source": "reddit_comment",
        "source_id": "reddit/c/k9f8d1",
        "product": "codex",
        "title": "Rate-limit backoff is wildly wrong",
        "description": "Reset header is a Unix timestamp but the client treats it as seconds-from-now, so it hammers the API when it should wait.",
        "url": "https://reddit.com/r/programming/comments/1n2abc/c/k9f8d1",
        "category_id": "cat-api-rate-limit",
        "severity": "medium",
        "sentiment_score": -0.35,
        "engagement_score": 37.0,
        "mention_count": 6,
        "affected_segments": ["smb", "indie"],
        "root_cause_id": "rc-rate-limit-parse",
        "created_at": "2025-09-05T13:44:00Z",
    },
    {
        "id": "iss-009",
        "source": "github_issue",
        "source_id": "openai/codex/12777",
        "product": "codex",
        "title": "Compaction recurses indefinitely on our internal monorepo",
        "description": "Summarizer re-enters compaction during its own output, and the agent eventually times out without producing a plan.",
        "url": "https://github.com/openai/codex/issues/12777",
        "category_id": "cat-context-overflow",
        "severity": "critical",
        "sentiment_score": -0.72,
        "engagement_score": 88.0,
        "mention_count": 26,
        "affected_segments": ["enterprise"],
        "root_cause_id": "rc-compact-rs",
        "created_at": "2025-10-08T11:30:00Z",
    },
    {
        "id": "iss-010",
        "source": "stackoverflow_question",
        "source_id": "so/79022222",
        "product": "codex",
        "title": "Quota exhausted with phantom tokens",
        "description": "The billing page says I've used 3x the tokens I actually sent. Support confirmed a tokenizer mismatch.",
        "url": "https://stackoverflow.com/q/79022222",
        "category_id": "cat-token-counting",
        "severity": "high",
        "sentiment_score": -0.48,
        "engagement_score": 44.0,
        "mention_count": 11,
        "affected_segments": ["smb", "indie"],
        "root_cause_id": "rc-token-count",
        "created_at": "2025-09-01T16:10:00Z",
    },
    {
        "id": "iss-011",
        "source": "github_issue",
        "source_id": "openai/codex/12901",
        "product": "codex",
        "title": "Worker pool crashes + retry storm in the same incident",
        "description": "Pool OOMs, client retries aggressively, upstream returns 502, client retries more. Classic amplification.",
        "url": "https://github.com/openai/codex/issues/12901",
        "category_id": "cat-session-memory",
        "severity": "critical",
        "sentiment_score": -0.70,
        "engagement_score": 83.0,
        "mention_count": 19,
        "affected_segments": ["enterprise", "professional"],
        "root_cause_id": "rc-memory-alloc",
        "created_at": "2025-10-25T08:05:00Z",
    },
    {
        "id": "iss-012",
        "source": "reddit_post",
        "source_id": "reddit/1pbq22",
        "product": "codex",
        "title": "My Codex session forgot what tools it had after a reconnect",
        "description": "After a 10-second blip the agent re-initialized the tool list out of order and started calling the wrong endpoints.",
        "url": "https://reddit.com/r/OpenAI/comments/1pbq22",
        "category_id": "cat-session-memory",
        "severity": "high",
        "sentiment_score": -0.52,
        "engagement_score": 41.0,
        "mention_count": 8,
        "affected_segments": ["ai-ml", "professional"],
        "root_cause_id": "rc-session-reconnect",
        "created_at": "2025-08-28T19:20:00Z",
    },
    {
        "id": "iss-013",
        "source": "github_discussion",
        "source_id": "openai/codex/disc/912",
        "product": "codex",
        "title": "Compaction eats my prompt before the task runs",
        "description": "If my repo context is large, compaction triggers immediately and deletes the user instructions.",
        "url": "https://github.com/openai/codex/discussions/912",
        "category_id": "cat-context-overflow",
        "severity": "critical",
        "sentiment_score": -0.67,
        "engagement_score": 75.0,
        "mention_count": 17,
        "affected_segments": ["enterprise", "professional"],
        "root_cause_id": "rc-compact-rs",
        "created_at": "2025-10-14T15:50:00Z",
    },
    {
        "id": "iss-014",
        "source": "github_issue",
        "source_id": "openai/codex/13044",
        "product": "codex",
        "title": "Review skips files that changed most",
        "description": "Codex consistently omits the largest changed files from its review output — exactly the ones we need reviewed.",
        "url": "https://github.com/openai/codex/issues/13044",
        "category_id": "cat-code-review",
        "severity": "high",
        "sentiment_score": -0.58,
        "engagement_score": 64.0,
        "mention_count": 13,
        "affected_segments": ["enterprise"],
        "root_cause_id": "rc-code-review-truncate",
        "created_at": "2025-11-03T12:12:00Z",
    },
    {
        "id": "iss-015",
        "source": "hackernews",
        "source_id": "hn/41999888",
        "product": "codex",
        "title": "Silent truncation is the worst kind of bug",
        "description": "Found through pain that Codex was dropping the end of our prompt past ~180k tokens with no signal.",
        "url": "https://news.ycombinator.com/item?id=41999888",
        "category_id": "cat-context-overflow",
        "severity": "medium",
        "sentiment_score": -0.40,
        "engagement_score": 56.0,
        "mention_count": 10,
        "affected_segments": ["professional", "ai-ml"],
        "root_cause_id": "rc-context-overflow",
        "created_at": "2025-10-21T22:37:00Z",
    },
    {
        "id": "iss-016",
        "source": "github_issue",
        "source_id": "microsoft/vscode-codex/552",
        "product": "codex",
        "title": "VS Code extension aborts completions after 30s",
        "description": "During latency spikes the extension cancels a request at 30s even though the model is still generating.",
        "url": "https://github.com/microsoft/vscode-codex/issues/552",
        "category_id": "cat-unexpected-behavior",
        "severity": "medium",
        "sentiment_score": -0.32,
        "engagement_score": 42.0,
        "mention_count": 7,
        "affected_segments": ["indie", "smb"],
        "root_cause_id": "rc-ide-timeout",
        "created_at": "2025-10-30T05:48:00Z",
    },
]


# 16-month timeline: Jan 2025 → Apr 2026.
# Sentiment is 0–100 (brief convention). Issue frequency is monthly mention
# count across all tracked sources. Status enum: baseline, emerging, crisis,
# peak_crisis, recovery, recovered.
TIMELINE: list[dict[str, Any]] = [
    {"month": "2025-01-01", "sentiment": 72.0, "issue_freq": 12, "status": "baseline", "note": "Pre-crisis baseline"},
    {"month": "2025-02-01", "sentiment": 70.0, "issue_freq": 18, "status": "baseline", "note": None},
    {"month": "2025-03-01", "sentiment": 68.0, "issue_freq": 25, "status": "emerging", "note": "First compact.rs reports"},
    {"month": "2025-04-01", "sentiment": 65.0, "issue_freq": 35, "status": "emerging", "note": None},
    {"month": "2025-05-01", "sentiment": 60.0, "issue_freq": 52, "status": "emerging", "note": None},
    {"month": "2025-06-01", "sentiment": 55.0, "issue_freq": 85, "status": "crisis", "note": "Code review truncation surfaces"},
    {"month": "2025-07-01", "sentiment": 48.0, "issue_freq": 145, "status": "crisis", "note": None},
    {"month": "2025-08-01", "sentiment": 42.0, "issue_freq": 210, "status": "crisis", "note": "OOM cluster detected"},
    {"month": "2025-09-01", "sentiment": 38.0, "issue_freq": 280, "status": "peak_crisis", "note": None},
    {"month": "2025-10-01", "sentiment": 35.0, "issue_freq": 320, "status": "peak_crisis", "note": "Crisis trough — 66% task failure rate"},
    {"month": "2025-11-01", "sentiment": 42.0, "issue_freq": 240, "status": "recovery", "note": "v0.56 fixes shipped"},
    {"month": "2025-12-01", "sentiment": 52.0, "issue_freq": 165, "status": "recovery", "note": None},
    {"month": "2026-01-01", "sentiment": 62.0, "issue_freq": 110, "status": "recovery", "note": None},
    {"month": "2026-02-01", "sentiment": 70.0, "issue_freq": 75, "status": "recovery", "note": None},
    {"month": "2026-03-01", "sentiment": 76.0, "issue_freq": 55, "status": "recovered", "note": None},
    {"month": "2026-04-01", "sentiment": 82.0, "issue_freq": 40, "status": "recovered", "note": "Full recovery"},
]


# ---------------------------------------------------------------------------
# Per-category monthly timeseries (7 categories × 16 months = 112 rows).
# Anchored to the brief's stated peak-month (Oct 2025) and recovery-month
# (Apr 2026) numbers; intermediate months follow the same shape as the
# overall TIMELINE scaled to each category's peak/recovery counts.
# ---------------------------------------------------------------------------

# (peak_issues, peak_sentiment, recovery_issues, recovery_sentiment)
_CATEGORY_ANCHORS: dict[str, tuple[int, float, int, float]] = {
    "cat-session-memory": (16, 30.0, 4, 82.0),
    "cat-token-counting": (15, 29.0, 3, 80.0),
    "cat-context-overflow": (15, 32.0, 3, 83.0),
    "cat-code-review": (12, 40.0, 3, 78.0),
    "cat-regression-quality": (10, 42.0, 2, 79.0),
    "cat-unexpected-behavior": (9, 45.0, 3, 68.0),       # slowest recovery
    "cat-api-rate-limit": (8, 38.0, 1, 86.0),            # highest peak sentiment
}

# Normalized monthly shape (relative to peak at Oct 2025 = 1.0).
_ISSUE_SHAPE = [0.04, 0.06, 0.09, 0.13, 0.20, 0.32, 0.55, 0.78, 0.93, 1.00,
                0.75, 0.50, 0.30, 0.20, 0.13, None]  # last slot = recovery anchor

# Sentiment shape baseline→trough→recovery (0 at trough, 1 at recovery baseline).
_SENTIMENT_SHAPE = [0.90, 0.88, 0.85, 0.80, 0.72, 0.62, 0.50, 0.38, 0.22, 0.00,
                    0.20, 0.42, 0.60, 0.78, 0.90, None]  # last slot = recovery anchor


def _category_timeline(cat_id: str) -> list[dict[str, Any]]:
    peak_issues, trough_sent, rec_issues, rec_sent = _CATEGORY_ANCHORS[cat_id]
    baseline_sent = 75.0  # pre-crisis baseline for every category
    months = [t["month"] for t in TIMELINE]
    statuses = [t["status"] for t in TIMELINE]
    out: list[dict[str, Any]] = []
    for i, month in enumerate(months):
        if i == len(months) - 1:
            issues = rec_issues
            sentiment = rec_sent
        else:
            issues = max(1, round(peak_issues * _ISSUE_SHAPE[i]))
            # Interpolate sentiment between baseline and trough using shape.
            shape = _SENTIMENT_SHAPE[i]
            sentiment = round(trough_sent + (baseline_sent - trough_sent) * shape, 1)
        out.append({
            "category_id": cat_id,
            "month": month,
            "issue_count": issues,
            "sentiment": sentiment,
            "status": statuses[i],
        })
    return out


CATEGORY_TIMESERIES: list[dict[str, Any]] = [
    row for cat in CATEGORIES for row in _category_timeline(cat["id"])
]


# Quick lookups
CATEGORY_BY_ID = {c["id"]: c for c in CATEGORIES}
CATEGORY_BY_SLUG = {c["slug"]: c for c in CATEGORIES}
SEGMENT_BY_ID = {s["id"]: s for s in USER_SEGMENTS}
SEGMENT_BY_SLUG = {s["slug"]: s for s in USER_SEGMENTS}
ROOT_CAUSE_BY_ID = {r["id"]: r for r in ROOT_CAUSES}
ISSUE_BY_ID = {i["id"]: i for i in ISSUES}


def issues_for_root_cause(root_cause_id: str) -> list[dict[str, Any]]:
    return [i for i in ISSUES if i["root_cause_id"] == root_cause_id]


def issues_for_segment(segment_slug: str) -> list[dict[str, Any]]:
    return [i for i in ISSUES if segment_slug in i["affected_segments"]]


def issues_for_category(category_id: str) -> list[dict[str, Any]]:
    return [i for i in ISSUES if i["category_id"] == category_id]


def category_timeseries(category_id: str) -> list[dict[str, Any]]:
    return [t for t in CATEGORY_TIMESERIES if t["category_id"] == category_id]


def crisis_peak() -> dict[str, Any]:
    return min(TIMELINE, key=lambda t: t["sentiment"])


def recovery_peak() -> dict[str, Any]:
    return max(TIMELINE, key=lambda t: t["sentiment"])
