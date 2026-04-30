# Codex phased execution prompt (canonical phased spec)

## Objective
Execute work in **phases**, with exactly **one phase implemented per run**. Each run must complete the selected phase, satisfy that phase’s acceptance criteria, and then stop with a handoff checklist for the next phase.

## Constraints / non-goals
- Never implement more than one phase in a single run.
- If a dependency from a later phase is required, add compile-time stubs/interfaces only.
- Do not ship production behavior for future phases early.
- Keep one canonical definition for schema fields, normalization, and redaction.
- **Conflict resolution:** If two sections conflict, follow: Constraints > Required files > Acceptance criteria > examples.

## Required files
Use only the files relevant to the active phase:
- **Phase 1 (Shared contracts + ingestion API):**
  - `lib/**` (schema/redaction/normalization/type-safe mappers)
  - `app/api/**/route.ts` (ingestion endpoints)
  - `tests/**` (schema/redaction/normalization/route tests)
  - `docs/**` (optional contract documentation)
- **Phase 2 (CLI collector):**
  - `packages/**` or `cli/**` (argument parsing, flow, transport client)
  - `tests/**` (CLI and collector-to-ingestion coverage)
  - shared interfaces required by CLI
- **Phase 3 (GitHub integration + admin evidence UI):**
  - provider integration files for GitHub ingestion
  - admin evidence panel UI/API files
  - `tests/**` (integration + UI/API behavior)

## Data schema
Single canonical ingestion contract used across all phases:
- Validate required/optional fields at parse time via shared schema utilities.
- Map raw inputs to normalized domain types via type-safe mappers.
- Enforce deterministic normalization (same input -> same output).
- Centralized redaction rules:
  - mask PII,
  - mask secrets/tokens/credentials,
  - never persist/return unredacted sensitive values.

## API behavior
- **Phase 1:** ingestion routes validate, normalize, redact, and persist/return safe payloads with predictable validation errors on failure.
- **Phase 2:** CLI submits payloads to Phase 1 ingestion APIs; API contracts remain stable.
- **Phase 3:** provider and admin API integrations must continue honoring canonical schema and redaction guarantees.

## CLI commands
- **Phase 1:** no CLI runtime implementation (stubs only if required).
- **Phase 2:** implement CLI collector behavior (arg parsing, defaults, errors, submit flow).
- **Phase 3:** no net-new CLI scope unless strictly needed to support provider/admin integration.

## UI behavior
- **Phase 1:** no admin UI runtime implementation (stubs only if required).
- **Phase 2:** no UI runtime scope.
- **Phase 3:** implement admin evidence panel behavior for imported evidence inspection.

## Testing
Split tests into execution tiers:
- **Tier A (must pass):** schema parsing, redaction/normalization, API unconfirmed rejection + valid acceptance, classifier request body.
- **Tier B (should pass):** log parser matrix, GitHub body builder.
- **Tier C (nice-to-have for phase):** CLI interaction tests.

Run only tests relevant to the active phase and applicable tiers:
- **Phase 1:** prioritize Tier A coverage for schema/redaction/API behavior.
- **Phase 2:** include Tier A plus Tier C CLI argument/default/error and collector-to-ingestion integration tests.
- **Phase 3:** include Tier A plus Tier B GitHub fetch/map/ingest integration + admin panel UI/API behavior tests.
- For every phase, verify future-phase production behavior is not prematurely implemented.

Execution rules:
- **If any Tier A test fails, do not proceed to final summary.**
- **If Tier B or Tier C tests are omitted, list the exact missing tests and why they were omitted.**

## Acceptance criteria
A run is complete only when all are true for the active phase:
1. In-scope files for that phase contain the required implementation.
2. Canonical schema/normalization/redaction rules are applied consistently.
3. Required tests for that phase pass (happy paths + key failures).
4. No production behavior from later phases is implemented beyond minimal stubs.
5. Output a handoff checklist for the next phase including:
   - completed phase + acceptance status,
   - changed files and exported interfaces,
   - known gaps/risks/TODO stubs,
   - exact tests run with pass/fail.


## Unified release gates (single source of truth)
This file is the canonical source for phased release criteria, including required files, status reporting, exit criteria, and verification requirements.

### Status format (required)
Use `PASS | FAIL | PARTIAL` for each phase and each required file.

- **PASS**: all required files and exit criteria are satisfied, and required verification/tests pass.
- **PARTIAL**: some required files or criteria are complete, but one or more required items are missing/inconclusive.
- **FAIL**: critical required files/criteria are missing, or required verification/tests fail.

When reporting status, include: (1) phase status, (2) short rationale, (3) failing/missing criteria bullets, (4) exact verification/tests executed.

### Phase 1 — Feedback Contract + Server Ingestion
**Required files:** `lib/codex-feedback/schema.ts`, `app/api/feedback/codex/route.ts`, `tests/**` for schema+ingestion.

**Exit criteria:**
- schema runtime + TS exports exist;
- `source === "codex-self-report"`;
- `schema_version: "codex_issue_context.v1"`;
- strict object validation;
- server rejects unconfirmed submissions;
- structured errors + deterministic success envelope;
- redaction before persistence/logging.

**Required verification/tests:** schema edge cases; API rejection/acceptance; method/body-size guardrails; structured errors.

### Phase 2 — Local Collector CLI
**Required files:** `packages/codex-issue-collector/src/cli.ts`, supporting CLI modules, `tests/**` for command behavior/submission flow.

**Exit criteria:** supports `capture|report|submit|github|doctor|preview`; invalid usage non-zero + help; failures propagate; preview avoids network; machine-readable mode separates stdout/stderr.

**Required verification/tests:** command matrix; exit-code propagation; dry-run no-network; collector-to-ingestion integration.

### Phase 3 — GitHub Issue Integration
**Required files:** GitHub provider ingestion/fetch/map files, issue body builder modules, `tests/**` for fetch/map/ingest + body building.

**Exit criteria:** canonical mapping without drift; deterministic body sections/order; preserves Phase 1 redaction/privacy; actionable non-secret diagnostics.

**Required verification/tests:** mapping matrix, body builder structure/snapshot tests, end-to-end ingest simulation.

### Phase 4 — Admin Evidence Panel
**Required files:** admin evidence UI components, admin evidence APIs/routes, shared evidence display types/selectors, `tests/**` for UI/API behavior.

**Exit criteria:** evidence loads/renders for selected report; no sensitive leakage; deterministic loading/empty/error/success states; UI evidence matches canonical payload.

**Required verification/tests:** API auth/shape/errors; UI state tests; sensitive-value non-render regression.

### Phase 5 — Classification Quality Loop
**Required files:** classifier payload handling modules, review/feedback loop files, quality metrics/audit modules, `tests/**` for classifier quality + review workflows.

**Exit criteria:** stable validated classifier request body; adjudication/feedback loop supported; metrics detect regressions; prior phase contracts remain compatible.

**Required verification/tests:** classifier body validation; review workflow paths; known-edge regression tests; cross-phase schema compatibility test.
