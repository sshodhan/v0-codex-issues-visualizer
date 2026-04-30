# Required File Validation Checks

Use this checklist when reviewing Codex feedback ingestion and collector behavior.

## `lib/codex-feedback/schema.ts`

- [ ] Exports both `CodexIssueContextV1Schema` (runtime validator) and `CodexIssueContextV1` (TypeScript type).
- [ ] Enforces `source` literal as `"codex-self-report"`.
- [ ] Validates `version` as the V1 contract (`"1"` or `1`, depending on implementation convention).
- [ ] Requires `privacy.user_confirmed_submission === true` in the server-side validation path.
- [ ] Rejects unknown top-level keys (strict object validation).

## `app/api/feedback/codex/route.ts`

- [ ] Rejects payloads exceeding max body size with HTTP `413`.
- [ ] Returns structured JSON errors (`code`, `message`, and optional `details`) for all 4xx validation failures.
- [ ] Redacts sensitive fields server-side before persistence/logging.
- [ ] Returns a deterministic success envelope with request ID and accepted timestamp.
- [ ] Applies explicit method guardrails (e.g., rejects unsupported verbs with `405`).

## `packages/codex-issue-collector/src/cli.ts`

- [ ] Supports `capture`, `report`, `submit`, `github`, `doctor`, and `preview` commands.
- [ ] Invalid command usage exits non-zero and prints command-specific help.
- [ ] Subcommand failures propagate non-zero exit codes to the parent process.
- [ ] Includes a dry-run/preview path that avoids network submission.
- [ ] Ensures machine-readable mode (if present) writes JSON to stdout and diagnostics to stderr.

## Checklist Status Template (required in report output)

When reporting results, include one status block per required file:

- `lib/codex-feedback/schema.ts`: `PASS | FAIL | PARTIAL`
- `app/api/feedback/codex/route.ts`: `PASS | FAIL | PARTIAL`
- `packages/codex-issue-collector/src/cli.ts`: `PASS | FAIL | PARTIAL`

Each status should include a short reason and any failing check bullets.
