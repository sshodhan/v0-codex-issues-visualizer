# Codex Issue Classification (OpenAI Responses API)

This repo now includes a standalone API route for structured issue classification:

- Route: `POST /api/classify`
- Model default: `gpt-5-mini` (`CLASSIFIER_MODEL_SMALL`)
- Escalation model: `gpt-5` (`CLASSIFIER_MODEL_LARGE`) when `confidence < 0.7`
- Temperature: `0.2`
- Structured output: JSON schema (`strict: true`)

## Request payload

Matches the report summary builder contract in `lib/classification/report-summary.ts`.

Required:

- `report_text`

Optional:

- `env`, `repro`, `transcript_tail`, `tool_calls_tail`, `breadcrumbs`, `logs`, `screenshot_or_diff`

## Server-side guards

`app/api/classify/route.ts` enforces:

1. Enum validation (`category`, `severity`, `status`, `reproducibility`, `impact`) with explicit 400 responses and valid options.
2. `evidence_quotes` substring validation against the user-turn payload.
3. Hard human-review rules for low confidence, critical severity, safety-policy, and sensitive report text.
4. Optional dual-write to Supabase table `bug_report_classifications`.

## Persistence

Migration: `scripts/003_create_bug_report_classifications.sql`

- Stores normalized columns + `raw_json` verbatim payload.
- Adds triage index on `(category, severity, needs_human_review, created_at DESC)`.
- Includes `related_report_ids` for dedupe/cross-link workflows.
