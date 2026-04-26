# Codex Issue Classification (OpenAI Responses API)

> **Naming note.** Three "category"-like fields in this system live in
> intentionally disjoint namespaces:
>
> | Field                        | UI label              | Source                                                  |
> |------------------------------|-----------------------|---------------------------------------------------------|
> | Heuristic regex bucket       | **"Topic"**           | `lib/scrapers/shared.ts:categorizeIssue` → `categories` table |
> | Strict-schema enum (14)      | **"LLM category"**    | `classifications.category` (this doc, v2 taxonomy)      |
> | Stable mechanism slug        | **"LLM subcategory"** | `classifications.subcategory` (this doc, snake_case 2–4 words) |
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

## Taxonomy (v2)

The `category` field is constrained to a 14-value enum defined in
`lib/classification/taxonomy.ts` (`CATEGORY_ENUM`). Each value carries a
structured `CATEGORY_DEFINITIONS` entry — a one-line meaning, concrete
`pick_when` signals, and `not_when` tiebreakers against the closest-confusion
sibling — that the prompt renders into the system message at build time. The
strict JSON schema picks up `CATEGORY_ENUM` directly, so taxonomy edits in
`taxonomy.ts` automatically propagate to the model contract, the prompt, and
the UI label/palette map (`lib/classification/llm-category-display.ts`).

`alternate_categories` is constrained to the same enum at both the strict
schema (`items.enum: CATEGORY_ENUM`) and `validateEnumFields()`.

The v1 → v2 vocabulary remap is handled by
`scripts/019_migrate_llm_categories.sql`. See that file's header for the
deploy order, replay caveat, and rollback steps.

### Subcategory guidance

`subcategory` is the second axis of the client-side `(effective_category,
subcategory)` triage group. It's intentionally text (≤ 60 chars) rather than
a hard enum, but the prompt's SUBCATEGORY GUIDANCE block (rendered from
`SUBCATEGORY_EXAMPLES` in `taxonomy.ts`) gives the model a per-category seed
list of stable snake_case mechanism slugs and rules:

- snake_case, 2–4 words, concrete mechanism over broad symptom.
- Reuse exact spellings from the seed list when one fits; coin a new slug
  only when none do.
- Forbidden vague labels: `bug`, `issue`, `problem`, `failure`, `error`,
  `other`. Falls back to `unknown_mechanism` when the model cannot infer a
  concrete mechanism.
- Subcategory must not repeat the category name.

### Tags vs subcategory

`subcategory` is the single root-cause mechanism. `tags` are orthogonal
facets: language (`typescript`, `python`), surface (`cli`,
`vscode-extension`, `jetbrains-plugin`), workflow stage (`pre-commit`, `ci`,
`deploy`). Subcategory is required; tags are optional and capped at 8.

### Few-shot anchors and anti-bias guard

The system prompt embeds 7 worked examples that anchor the tiebreaker for
the most-confused category pairs:

| Slot | Source | Category |
|---|---|---|
| A | `github.com/openai/codex/issues/13627` | `retrieval_context_mismatch` (cwd switch after compaction) |
| B | synthetic | `dependency_environment_failure` (3-way: tool vs env vs plugin) |
| C | `github.com/openai/codex/issues/6765` | `hallucinated_code` (Firebase Auth `continueUrl` fabrication) |
| D | `github.com/anthropics/claude-code/issues/15804` | `structural_dependency_oversight` (PHP signature) |
| E | `github.com/openai/codex/issues/4969` | `autonomy_safety_violation` (deleted uncommitted files) |
| F | `github.com/openai/codex/issues/6885` | `code_generation_bug` (weak Lua regression assertion) |
| G | `github.com/openai/codex/issues/8564` | `user_intent_misinterpretation` (Chat-mode constraint ignored) |

Six are verbatim public bug reports; one (B) is synthetic because no
public report cleanly disambiguates the 3-way tool/env/plugin bucket.
Each example cites its source URL inline so future maintainers can audit
the anchor against the original report.

E and G are deliberately paired — they teach the safety-vs-intent
tiebreaker in both directions. E shows when the destructive action
itself is the primary harm (`autonomy_safety_violation` with
`user_intent_misinterpretation` as alternate); G shows when ignoring a
stated constraint is the primary harm (`user_intent_misinterpretation`
with `autonomy_safety_violation` as alternate).

The prompt also includes a USING THE EXAMPLES anti-bias guard (rendered
between HARD RULES and the examples block) that tells the model:

- Examples are tiebreakers, not templates.
- Don't pattern-match on surface similarity (product, vocabulary, prose
  style) or recency / memorability bias.
- "Codex deleted X" alone does not make a report
  `autonomy_safety_violation` — the destruction must actually have been
  an unauthorized action.
- If the report doesn't fit any of the 14 categories well, lower
  confidence below 0.7 and let HARD RULE 5 route it to human review.
  Forcing a confident classification onto a category that doesn't match
  is a worse failure than admitting uncertainty.

#### Refresh policy

Re-evaluate the few-shot anchors annually, or when the v2 taxonomy
distribution observed in `classifications.category` shifts > 20% from
the previous quarter. Examples bias the model toward these specific
failure-mode patterns by design — stale anchors become drag.

`scripts/extract-prompt-candidates.sql` (and the equivalent TS at
`scripts/extract-prompt-candidates.ts`) pulls real candidate
`observations` rows by keyword for the most-confused category pairs;
operators can swap an example by replacing the relevant block in
`lib/classification/prompt.ts` `FEW_SHOT_EXAMPLES`. The
`tests/classifier-prompt.test.ts` `prompt contains exactly 7 anchored
few-shot examples` test acts as a regression guard so a future edit
can't silently drop one.

## Request payload

Matches the report summary builder contract in `lib/classification/report-summary.ts`.

Required:

- `report_text`

Optional:

- `env`, `repro`, `transcript_tail`, `tool_calls_tail`, `breadcrumbs`, `logs`, `screenshot_or_diff`

## Server-side guards

`app/api/classify/route.ts` enforces:

1. Enum validation for `category`, `severity`, `status`, `reproducibility`, `impact`, and `alternate_categories[]` with explicit 400 responses and valid options. `alternate_categories` is constrained to the same 14-value `CATEGORY_ENUM` as `category` (see `lib/classification/schema.ts`).
2. `evidence_quotes` substring validation against the user-turn payload — every quote must appear verbatim in `report_text`, `transcript_tail`, `tool_calls_tail`, `breadcrumbs`, or `logs`.
3. Hard human-review rules for low confidence, critical severity, `category=autonomy_safety_violation`, and sensitive report text (`data loss`, `secret`, `billing`, `customer`).

## Persistence

Migrations:

- `scripts/007_three_layer_split.sql` — creates `classifications` (immutable baseline) and `classification_reviews` (append-only reviewer overrides) in the three-layer schema.
- `scripts/019_migrate_llm_categories.sql` — backfills legacy v1 category slugs to the v2 taxonomy.
- `scripts/020_classification_reviews_add_subcategory.sql` — adds `classification_reviews.subcategory` so reviewers can override the LLM mechanism slug independently of category.

Reviewer overrides are append-only via `record_classification_review` (SECURITY DEFINER); `effective_category` and `effective_subcategory` resolve to the latest review row by `reviewed_at desc`, falling back to the baseline classification when no override exists.


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
| `category`, `subcategory` | LLM enum (14 values, v2 taxonomy in `lib/classification/taxonomy.ts` `CATEGORY_ENUM` + `CATEGORY_DEFINITIONS`; "LLM category" in UI) + text ≤ 60 chars with stable per-category seed list (`SUBCATEGORY_EXAMPLES`; "LLM subcategory" in UI) | Row, breadcrumb (Layer B), reviewer override **and subcategory override** input, IssuesTable "All LLM Subcategories" filter, Hero classification-cloud pills | `effective_category` and `effective_subcategory` reflect the latest review override (subcategory override added in `scripts/020_classification_reviews_add_subcategory.sql`); do not confuse with the heuristic "Topic" (`categories` table) |
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
