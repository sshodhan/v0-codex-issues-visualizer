# Required File Validation Checks (derived quick checklist)

This file is a reviewer-friendly quick checklist derived from the canonical phased spec.

- **Canonical source of truth:** `docs/CODEX_PHASED_EXECUTION_PROMPT.md`.
- If this file and the canonical doc conflict, follow `docs/CODEX_PHASED_EXECUTION_PROMPT.md`.

## Quick per-file checklist (derived from canonical)

### `lib/codex-feedback/schema.ts`
- [ ] Exports both `CodexIssueContextV1Schema` (runtime validator) and `CodexIssueContextV1` (TypeScript type).
- [ ] Enforces `source === "codex-self-report"`.
- [ ] Validates `schema_version: "codex_issue_context.v1"`.
- [ ] Uses strict object validation (reject unknown top-level keys).

### `app/api/feedback/codex/route.ts`
- [ ] Requires `privacy.user_confirmed_submission === true` on server-side validation path.
- [ ] Rejects oversized payloads with HTTP `413`.
- [ ] Returns structured 4xx validation errors (`code`, `message`, optional `details`).
- [ ] Redacts sensitive fields before persistence/logging.
- [ ] Returns deterministic success envelope (`requestId`, accepted timestamp).
- [ ] Applies method guardrails (reject unsupported verbs with `405`).

### `packages/codex-issue-collector/src/cli.ts`
- [ ] Supports `capture`, `report`, `submit`, `github`, `doctor`, and `preview`.
- [ ] Invalid usage exits non-zero and prints command-specific help.
- [ ] Subcommand failures propagate non-zero exit code.
- [ ] Includes dry-run/preview path with no network submission.
- [ ] Machine-readable mode (if present) writes JSON to stdout and diagnostics to stderr.

## Status report template (copy/paste)
```md
Phase: <Phase N Name>
Status: PASS | FAIL | PARTIAL
Summary: <one-line rationale>
Missing/Failing criteria:
- <criterion or "none">
Verification run:
- ✅ `<command>`
- ❌ `<command>`
- ⚠️ `<command>` (if omitted/blocked, explain why)
```
