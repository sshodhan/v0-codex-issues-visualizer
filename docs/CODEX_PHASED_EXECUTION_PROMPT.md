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
Run only tests relevant to the active phase:
- **Phase 1:** schema parsing edge cases, redaction/normalization, ingestion route success/failure.
- **Phase 2:** CLI argument/default/error tests + collector-to-ingestion integration tests.
- **Phase 3:** GitHub fetch/map/ingest integration + admin panel UI/API behavior tests.
- For every phase, verify future-phase production behavior is not prematurely implemented.

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
