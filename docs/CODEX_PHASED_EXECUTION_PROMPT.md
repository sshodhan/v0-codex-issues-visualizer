# Codex phased execution prompt (single phase per run)

Use this as the authoritative top-level prompt block for phased implementation runs.

## Global rules

- You must implement only **Phase 1** in this run.
- Do not start **Phase 2+** files.
- If a dependency from later phases is needed, stub interfaces only.

Codex must execute exactly one phase per run and stop after that phase's acceptance criteria are met. At stop time, output a handoff checklist for the next phase.

---

## Phase 1 — Shared schema/redaction/normalization + ingestion route + tests

### In-scope files
- `lib/**` files that define shared ingestion schema contracts, redaction helpers, normalization utilities, and type-safe mappers used by ingestion.
- `app/api/**/route.ts` files for ingestion endpoints required to land Phase 1.
- `tests/**` files that validate schema, redaction, normalization, and ingestion-route behavior.
- `docs/**` files only if needed to document Phase 1 contracts.

### Out-of-scope files
- CLI entrypoints/packages and command wiring.
- GitHub issue provider integration and any admin evidence panel UI.
- Any Phase 2/3 implementation files except minimal interface stubs required to compile.

### Required tests
- Unit tests for schema validation and parsing edge cases.
- Unit tests for redaction behavior (PII/secrets masking) and normalization behavior.
- Route/integration tests for ingestion endpoint success/failure paths.

### Acceptance criteria (Phase 1 only)
- Shared schema + redaction + normalization code exists and is used by ingestion route.
- Ingestion route persists/returns normalized payloads with redaction guarantees.
- Required tests pass and cover happy-path + key failure-path scenarios.
- No production Phase 2/3 behavior is implemented beyond optional compile-time stubs.

---

## Phase 2 — CLI collector package + tests

### In-scope files
- `packages/**` or `cli/**` collector package files (argument parsing, execution flow, transport client).
- `tests/**` covering CLI collector behavior.
- Shared interfaces consumed by CLI when integrating with Phase 1 contracts.

### Out-of-scope files
- GitHub issue integration and admin evidence panel UI.
- Any net-new Phase 3 runtime behavior except interface stubs.

### Required tests
- CLI unit tests for argument parsing, defaults, and error handling.
- Integration-style tests for collector-to-ingestion interactions.

### Acceptance criteria (Phase 2 only)
- CLI collector can package and submit valid payloads to ingestion.
- CLI behavior is deterministic and validated by tests.
- No production Phase 3 behavior is implemented beyond optional stubs.

---

## Phase 3 — GitHub issue integration + admin evidence panel + tests

### In-scope files
- Provider integration files for GitHub issues ingestion.
- Admin evidence panel UI/API files needed to inspect imported evidence.
- `tests/**` validating GitHub integration flow and admin-panel behavior.

### Out-of-scope files
- Reworking Phase 1/2 scope except bug fixes strictly required for Phase 3 completion.

### Required tests
- Integration tests for GitHub issue fetch/map/ingest flow.
- UI/API tests for admin evidence panel rendering and interactions.

### Acceptance criteria (Phase 3 only)
- GitHub issues are ingested through defined contracts and visible in admin evidence panel.
- Test coverage confirms end-to-end integration and failure handling.

---

## Stop rule and handoff checklist

After completing a phase, stop and output a handoff checklist for the next phase that includes:
- Current phase completed and acceptance criteria status.
- Files changed and interfaces exported for downstream phases.
- Known gaps, risks, and TODO stubs intentionally left for the next phase.
- Exact tests run and their pass/fail status.
