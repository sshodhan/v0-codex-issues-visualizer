# Required File Validation Checks (compatibility pointer)

This file is kept for compatibility links only.

- Canonical phase gates, required file expectations, status format (`PASS | FAIL | PARTIAL`), exit criteria, and verification requirements now live in `docs/CODEX_PHASED_EXECUTION_PROMPT.md`.
- Use `docs/CODEX_PHASED_EXECUTION_PROMPT.md` as the single source of truth for release criteria across phases and PRs.

## Legacy per-file checklist pointers
- `lib/codex-feedback/schema.ts`
- `app/api/feedback/codex/route.ts`
- `packages/codex-issue-collector/src/cli.ts`


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
