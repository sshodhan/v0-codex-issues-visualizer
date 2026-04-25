# Codex Issue Classification (OpenAI Responses API)

> **Naming note.** Three "category"-like fields in this system live in
> intentionally disjoint namespaces:
>
> | Field                        | UI label              | Source                                                  |
> |------------------------------|-----------------------|---------------------------------------------------------|
> | Heuristic regex bucket       | **"Topic"**           | `lib/scrapers/shared.ts:categorizeIssue` → `categories` table |
> | Strict-schema enum (12)      | **"LLM category"**    | `classifications.category` (this doc)                   |
> | Free-text per-issue tag      | **"LLM subcategory"** | `classifications.subcategory` (this doc)                |
>
> See `docs/ARCHITECTURE.md` §6.0 for the full glossary. The names
> `category` / `subcategory` in this doc and in the schema refer **only
> to the LLM strict-schema fields** — never to the heuristic Topic.

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

### Triage UI: which schema fields render where

The triage panel shows the full LLM-structured output for the selected record so reviewers don't have to query the database to validate a classification. Every field below comes from the `classifications` row joined to its current observation (see `app/api/classifications/route.ts`).

| Schema field | Source | Where it renders | Notes |
| --- | --- | --- | --- |
| `category`, `subcategory` | LLM enum (12 values; "LLM category" in UI) + free-text ≤60 chars ("LLM subcategory" in UI) | Row, breadcrumb (Layer B), reviewer override dropdown, IssuesTable "All LLM Subcategories" filter, Hero classification-cloud pills | `effective_*` reflects the latest review override; do not confuse with the heuristic "Topic" (`categories` table) |
| `severity` | LLM enum | Row badge, reviewer override dropdown | `effective_severity` after override |
| `status` | LLM enum | Row, reviewer override dropdown | `effective_status` after override |
| `confidence` | LLM 0..1 | Row column, reviewer panel header `C · NN%` badge | Triggers low-confidence hint when `< 0.7` (escalation threshold) |
| `summary` | LLM ≤ 280 chars | Reviewer panel sub-header | |
| `reproducibility` | LLM enum (`always` / `often` / `sometimes` / `once` / `unknown`) | `ClassificationContextPanel` enum field | New surface |
| `impact` | LLM enum (`single-user` / `team` / `org` / `fleet` / `unknown`) | `ClassificationContextPanel` enum field | New surface |
| `root_cause_hypothesis` | LLM ≤ 400 chars | `ClassificationContextPanel` "Root cause hypothesis" block | New surface |
| `suggested_fix` | LLM ≤ 600 chars | `ClassificationContextPanel` "Suggested fix" block | New surface |
| `evidence_quotes` | LLM array (≤ 5, ≤ 240 chars each) | `ClassificationContextPanel` quote list | Tagged "substring-validated against source" — `evidenceQuotesAreSubstrings()` enforces it server-side |
| `tags` | LLM array (≤ 8, ≤ 32 chars each) | `ClassificationContextPanel` tag chips | New surface |
| `needs_human_review` | LLM boolean | Row alert-triangle icon, hint banner | Effective value after override |
| `review_reasons` | LLM array (≤ 4) | `PerRecordPrereqHints` "Flagged for human review" hint | Joined inline so the reviewer sees *why* without expanding |
| `model_used`, `retried_with_large_model` | Pipeline metadata | `ClassificationContextPanel` provenance footer | "escalated" badge when the row was retried with the large model |
| `algorithm_version` | Pipeline metadata | Provenance footer + Review History collapsible | Used to date baseline classifications in audit trail |
| `cluster_id`, `cluster_label`, `cluster_label_confidence`, `cluster_size` | Joined from `mv_observation_current` + `clusters` | Layer-A breadcrumb segment, "Semantic cluster" sub-card, chip-strip filter | Surfaced to users as **"Family"** with `cluster_label` as the **"Family name"** — fallback "Unnamed family" when null/low-confidence. Null when clustering hasn't run / embedding failed / below threshold (see CLUSTERING_DESIGN.md §4.5). The technical noun "Semantic cluster (Layer A)" stays in methodology surfaces. |
| `source_issue_url`, `source_issue_title`, `source_issue_sentiment` | Joined from `mv_observation_current` | Row "Source feedback" link + sentiment badge | Traceability — never null after ingest if the observation has a URL |

The triage tab also surfaces the three-layer mental model explicitly via:

- **`LayerExplainerPanel`** — collapsible "How this works" card at the top of the triage tab. Open/closed state persists in `localStorage` under `classification-triage:layer-explainer-open`.
- **Layer badges** (`A` / `B` / `C`) — mounted on the chip-strip headings, every row breadcrumb, and the reviewer panel header so the doc vocabulary maps to UI surfaces unambiguously.
- **`PartialPipelineStrip`** — single-line CTA when records exist but the pipeline is behind (`pendingClassification` or `pendingClustering > 0`). Reuses `pickPrimaryCta(prereq)` from `lib/classification/prerequisites.ts` so the CTA decision is identical to the empty-state panel. Hidden when caught up.
- **`PerRecordPrereqHints`** — per-row hints with `/admin?tab=...` deep-links when the selected record has a Layer-A miss (no `cluster_id`), confidence below the escalation threshold, or `review_reasons` populated.

See `docs/CLUSTERING_DESIGN.md` §7 for the chip-strip / breadcrumb / pipeline-status surfaces. The **vocabulary lock** in that doc is normative: "cluster" always means Layer A, "group" always means Layer B, "classification" always means Layer C — do not introduce synonyms in code or copy.

## Layered signal view

The classifier is one of three layers in the per-observation `SignalLayers` panel (`components/dashboard/signal-layers.tsx`), alongside the raw report and the deterministic regex fingerprint (`lib/scrapers/bug-fingerprint.ts`). The panel stacks them top-down so an analyst can see *how* each pass contributes:

1. **Report** — title + truncated body.
2. **Regex signals** — error code, top stack frame + line-stable hash, CLI version, OS/shell/editor, model id, repro-marker count, keyword-presence count. Deterministic, cheap, always runs at ingest.
3. **LLM insights** — the full structured output from `classifications` (subcategory, severity, reproducibility, impact, summary, root-cause hypothesis, suggested fix, tags, evidence quotes, model used). Populated automatically by the ingest-time classification pipeline (§3.1d); the CTA below the layer lets a user force a fresh pass.

> Note: `SignalLayers` and the triage `ClassificationContextPanel` render the same underlying schema. `SignalLayers` is per-observation (one report's full signal stack); `ClassificationContextPanel` is per-classification inside the reviewer queue. They share `lib/classification/schema.ts` so there is no drift in field semantics.

## Runtime call paths

The same internal helper (`classifyReport` in `lib/classification/pipeline.ts`) backs three entry points:

| Entry point                                | Invoked by                                             | Writes to `classifications`? |
|--------------------------------------------|--------------------------------------------------------|------------------------------|
| `POST /api/classify`                       | External callers / ops tools                           | yes                          |
| `processObservationClassificationQueue`    | Scraper orchestrator, post-batch                       | yes (dedupe-guarded)         |
| `POST /api/observations/:id/classify`      | SignalLayers "Add / Refresh / Re-run LLM pass" CTA     | yes                          |
| `GET  /api/observations/:id/classify`      | SignalLayers mount (warm read, no model call)          | no — reads the latest row    |

`classifications` is the single source of truth for the LLM layer. The `bug_fingerprints` derivation deliberately does NOT denormalize classifier fields; `mv_observation_current` joins the latest `classifications` row per observation so dashboards pick up classifier updates on MV refresh without requiring a fingerprint rewrite.
