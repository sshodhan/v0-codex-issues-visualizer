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


## Dashboard integration

- Classifier queue API: `GET /api/classifications`
- Classifier stats API: `GET /api/classifications/stats`
- Reviewer update API: `PATCH /api/classifications/:id`
- UI panel: `components/dashboard/classification-triage.tsx`

Traceability is surfaced via source feedback fields (`source_issue_title`, `source_issue_url`, `source_issue_sentiment`) so every classification can be traced to the original web report.

## Layered signal view

The classifier is one of three layers in the per-observation `SignalLayers` panel (`components/dashboard/signal-layers.tsx`), alongside the raw report and the deterministic regex fingerprint (`lib/scrapers/bug-fingerprint.ts`). The panel stacks them top-down so an analyst can see *how* each pass contributes:

1. **Report** — title + truncated body.
2. **Regex signals** — error code, top stack frame + line-stable hash, CLI version, OS/shell/editor, model id, repro-marker count, keyword-presence count. Deterministic, cheap, always runs at ingest.
3. **LLM insights** — the full structured output from `classifications` (subcategory, severity, reproducibility, impact, summary, root-cause hypothesis, suggested fix, tags, evidence quotes, model used). Populated automatically by the ingest-time classification pipeline (§3.1d); the CTA below the layer lets a user force a fresh pass.

## Runtime call paths

The same internal helper (`classifyReport` in `lib/classification/pipeline.ts`) backs three entry points:

| Entry point                                | Invoked by                                             | Writes to `classifications`? |
|--------------------------------------------|--------------------------------------------------------|------------------------------|
| `POST /api/classify`                       | External callers / ops tools                           | yes                          |
| `processObservationClassificationQueue`    | Scraper orchestrator, post-batch                       | yes (dedupe-guarded)         |
| `POST /api/observations/:id/classify`      | SignalLayers "Add / Refresh / Re-run LLM pass" CTA     | yes                          |
| `GET  /api/observations/:id/classify`      | SignalLayers mount (warm read, no model call)          | no — reads the latest row    |

`classifications` is the single source of truth for the LLM layer. The `bug_fingerprints` derivation deliberately does NOT denormalize classifier fields; `mv_observation_current` joins the latest `classifications` row per observation so dashboards pick up classifier updates on MV refresh without requiring a fingerprint rewrite.
