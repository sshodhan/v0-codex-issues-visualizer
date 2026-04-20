# Codex Issues Visualizer — Architecture Guide

_Last updated: 2026-04-20 (v3 — providers split, Stack Overflow added)_

## 1) Purpose and product goals

This system collects public feedback about Codex/Copilot usage, enriches each report with sentiment/impact/category signals, and now adds an LLM-assisted triage layer with human review.

Primary goals:

1. **Detect what needs attention now** (issue spikes, urgency ranking).
2. **Preserve historical signal quality** (trend stability and classification quality over time).
3. **Guarantee analyst traceability** (every insight should link to source feedback on the web).
4. **Support reviewer-in-the-loop governance** (AI suggestion first, human authority final).
5. **Enable fast iteration** (clear extension points for sources, classifiers, and UI modules).

---

## 2) End-to-end architecture

```text
External Sources
  ├─ Reddit JSON API
  ├─ Hacker News Algolia API
  ├─ GitHub Issues Search API
  └─ Stack Exchange (Stack Overflow) API
         │
         ▼
Provider Scrapers (lib/scrapers/providers/*.ts)
  ├─ relevance filtering (Codex-focused)
  ├─ normalization + low-value filtering
  ├─ shared retry/backoff fetch
  ├─ sentiment scoring
  ├─ weighted category classification (heuristic)
  ├─ competitor mention detection
  └─ deduplication
         │
         ▼
Orchestrator (lib/scrapers/index.ts)
  ├─ runs all providers in parallel
  ├─ writes per-source scrape_logs
  └─ runScraper(slug) for single-source runs
         │
         ▼
Supabase (Postgres)
  ├─ issues
  ├─ categories
  ├─ sources
  ├─ scrape_logs
  └─ bug_report_classifications   <-- new LLM triage store
         │
         ├─ API: analytics/query layer
         │   ├─ /api/issues          (query/filter; supports q, days, source, category)
         │   ├─ /api/stats           (dashboard aggregates + realtime + competitive)
         │   ├─ /api/scrape          (trigger all scrapers)
         │   ├─ /api/scrape/[source] (trigger one scraper)
         │   └─ /api/cron/scrape     (Vercel cron entry)
         │
         └─ API: classifier/reviewer layer
             ├─ /api/classify
             ├─ /api/classifications
             ├─ /api/classifications/stats
             └─ /api/classifications/:id (PATCH)
         │
         ▼
Analytics modules (lib/analytics/*)
  ├─ realtime.ts     (urgency = volume × decay + momentum + impact + neg + diversity)
  └─ competitive.ts  (per-competitor mention counts + net sentiment)
         │
         ▼
Dashboard UI (app/page.tsx)
  ├─ KPI cards + trend/source/sentiment/category visuals
  ├─ realtime urgency insights (now with source diversity)
  ├─ competitive mentions panel
  ├─ issues table (source links)
  └─ classification triage panel (traceability + reviewer workflow)
```

---

## 3) Runtime flows

### 3.1 Ingestion + enrichment flow

1. A scrape is triggered manually (`/api/scrape`) or by cron route.
2. Source adapters fetch raw records.
3. Candidates are cleaned and filtered (normalize whitespace, relevance, low-value exclusions).
4. Remaining records are enriched with sentiment, heuristic category, and impact score.
5. Records are deduped and upserted to `issues` on `(source_id, external_id)`.
6. Run metadata is written to `scrape_logs`.

### 3.2 LLM classification flow (new)

1. Client/backend posts report payload to `/api/classify`.
2. Server builds bounded context (`report_text`, env, repro, transcript/tool/log tails).
3. OpenAI Responses API is called with strict JSON-schema response format (`temperature: 0.2`).
4. If `confidence < 0.7`, route retries once on larger model.
5. Boundary validation runs:
   - enum validation,
   - `evidence_quotes` substring validation against request payload,
   - hard review rules (critical/safety/low confidence/sensitive mentions).
6. Output is returned and optionally stored in `bug_report_classifications` as normalized fields + raw JSON.

### 3.3 Reviewer flow (new)

1. Dashboard fetches queue rows from `GET /api/classifications`.
2. Dashboard fetches queue KPIs from `GET /api/classifications/stats`.
3. Reviewer selects a row, checks source-link traceability, and updates status/category/severity/notes.
4. Dashboard sends patch to `PATCH /api/classifications/:id`.
5. Record is updated with reviewer metadata (`reviewed_by`, `reviewed_at`, `reviewer_notes`).

### 3.4 Insight traceability flow (new)

From any triage row, the analyst can verify:
- **Classification context** (`summary`, `category`, `severity`, confidence),
- **Sentiment linkage** (`source_issue_sentiment`),
- **Primary evidence path** (source issue title + URL back to external feedback).

This enables end-to-end provenance from dashboard insight → classifier decision → original web feedback.

---

## 4) Module map and responsibilities

### 4.1 `lib/scrapers/`

Layout:
- `lib/scrapers/index.ts` — orchestrator. `runAllScrapers()` (parallel) and
  `runScraper(slug)` (single-source). Owns scrape_logs lifecycle and upserts.
- `lib/scrapers/shared.ts` — relevance filters, sentiment, category scoring,
  impact scoring, competitor keyword detection, retry/backoff fetch helper,
  dedupe.
- `lib/scrapers/providers/{reddit,hackernews,github,stackoverflow}.ts` —
  one provider per file. Each owns its source-specific query and the
  mapping into a `Partial<Issue>`.

Extension guidance:
- Add a new provider by creating `providers/<slug>.ts` and registering it in
  the `SCRAPERS` map in `index.ts`. Add the matching `sources` row via a
  numbered SQL migration.
- Reuse shared helpers (`normalizeWhitespace`, `analyzeSentiment`,
  `categorizeIssue`, `fetchWithRetry`).
- Keep provider-specific query syntax local to each provider.
- Prefer explicit query grouping (or `optionalWords`-style boolean OR) to
  avoid boolean precedence bugs.

### 4.2 `app/api/stats/route.ts`

Responsibilities:
- Aggregate KPI + trend + realtime urgency metrics from `issues`.
- Pull a single 6-day window once and feed both realtime and competitive
  analytics from it (avoids duplicate queries).
- Normalize Supabase relation payload shape (`firstRelation`).

Heavy analytics live in `lib/analytics/*`:
- `lib/analytics/realtime.ts` — urgency-ranked category insights with
  source diversity and recency decay.
- `lib/analytics/competitive.ts` — per-competitor mention counts and net
  sentiment.

Extension guidance:
- Keep response backward-compatible for existing UI consumers.
- Add new metrics as additional analytics modules called from the route.
- Add versioning (`/api/stats?v=2`) before breaking response schema.

### 4.3 `app/api/classify/route.ts`

Responsibilities:
- Validates input contract for classification payload.
- Constructs bounded user turn for the model.
- Calls OpenAI with strict schema and retry-on-low-confidence path.
- Enforces boundary constraints and human-review gates.
- Writes normalized + raw records with source traceability metadata.

Extension guidance:
- Keep schema versions explicit at API boundary.
- Track prompt/schema/model versions per record for replayability.

### 4.4 `app/api/classifications/*`

Responsibilities:
- Queue retrieval (`GET /api/classifications`) with filter support.
- Queue KPI aggregation (`GET /api/classifications/stats`) including traceability coverage.
- Reviewer updates (`PATCH /api/classifications/:id`) with audit metadata timestamps.

Extension guidance:
- Add pagination + cursor strategy before queue size grows.
- Add reviewer override delta logging for training set curation.

### 4.5 `hooks/use-dashboard-data.ts`

Responsibilities:
- Typed contracts for dashboard stats/issues/classification queue.
- SWR refresh cadence and refresh orchestration.

Extension guidance:
- Split into feature hooks when payload surface area expands.
- Avoid client-side schema drift by co-locating API contract typings.

### 4.6 `components/dashboard/classification-triage.tsx`

Responsibilities:
- Display triage queue rows and traceability linkouts.
- Surface confidence/severity/sentiment/review flags.
- Capture reviewer overrides and notes.

Extension guidance:
- Keep mutations explicit (no implicit auto-approve).
- Add optimistic update only after conflict strategy is defined.

---

## 5) Data model summary

### 5.1 Existing operational tables

- `sources`: source registry.
- `categories`: canonical heuristic categories.
- `issues`: normalized issue facts from public sources.
- `scrape_logs`: ingestion run metadata and failures.

### 5.2 New triage table

- `bug_report_classifications`:
  - LLM output fields (`category`, `severity`, `confidence`, etc.),
  - raw payload (`raw_json`),
  - reviewer workflow fields (`status`, `reviewed_by`, `reviewed_at`, `reviewer_notes`),
  - traceability fields (`source_issue_id`, `source_issue_url`, `source_issue_title`, `source_issue_sentiment`),
  - model metadata (`model_used`, `retried_with_large_model`).

### 5.3 Key indexes and constraints

- Existing unique key for issues: `(source_id, external_id)`.
- Triage index: `(category, severity, needs_human_review, created_at DESC)`.
- Traceability index: `(source_issue_id, created_at DESC)`.

---

## 6) Analytics and triage quality model

### 6.1 Heuristic category model

Current model: weighted phrase matching with optional whole-word mode.

Why this exists:
- Improves over first-match substring logic.
- Allows stronger phrases to override weak incidental words.
- Supports category-specific weighting without model hosting overhead.

Future improvements:
1. Add confidence output (top-1 minus top-2 margin).
2. Route low-confidence to `other` or human review bucket.
3. Maintain evaluation set for precision/recall per category.

### 6.2 Realtime urgency scoring

Current score (`lib/analytics/realtime.ts`) blends:
- recency-decayed volume (linear from 1.0 at "now" to 0.0 at window edge),
- positive momentum (vs prior 72h window),
- average impact,
- negative sentiment ratio,
- source diversity (number of distinct sources reporting in the category).

Future improvements:
1. Add cross-source duplicate clustering (same story across HN + Reddit).
2. Per-category dynamic thresholds (some categories are noisy by default).
3. Anomaly detection for sudden surge alerts independent of urgency rank.

### 6.3 LLM triage quality controls (classification table)

Current controls:
- strict JSON schema output,
- enum boundary validation,
- substring evidence guard,
- mandatory human-review triggers for risky conditions.

### 6.4 Analyst-grade traceability requirements

For each reviewer-visible classification, target:
1. Source URL present (linkable back to external feedback).
2. Source sentiment populated.
3. Evidence quote list retained.
4. Reviewer action audit fields populated once adjudicated.

---

## 7) Operational playbook

### 7.1 When classifier quality drops

Checklist:
1. Compare reviewer overrides by category/severity.
2. Audit low-confidence distribution and retry rates.
3. Validate evidence-quote rejection rate and root causes.
4. Sample false positives where source URL is missing.

### 7.2 When traceability coverage drops

Checklist:
1. Monitor `% rows with source_issue_url`.
2. Validate mapping from ingest `issues` rows into classify requests.
3. Backfill `source_issue_*` fields for legacy rows where possible.
4. Block “authoritative” status transitions without source URL in strict mode.

### 7.3 Core health metrics

- scrape success rate by source,
- ingestion precision (sampled relevance),
- realtime insight precision (sampled relevance),
- classifier confidence distribution,
- reviewer override rate by category/severity,
- median time from `new` → `triaged`,
- traceability coverage (`source_issue_url` present),
- % reviewed rows with reviewer notes.

---

## 8) Near-term roadmap (data-analyst lens)

### Short-term (1–2 sprints)

- Add queue pagination and stage-based filters (`new`, `triaged`, `in-progress`, etc.).
- Build reviewer override deltas table for model-eval corpora.
- Add explicit dashboard card for traceability coverage trend over time.
- Add contract tests for `/api/classify` and `/api/classifications/*`.

### Medium-term (1–2 months)

- Introduce agreement metrics between heuristic category and LLM category.
- Add anomaly alerts for sudden spikes in critical/safety-policy classifications.
- Implement weekly few-shot refresh from highest-signal reviewed overrides.

### Long-term

- Hybrid pipeline (heuristics + embeddings + LLM adjudication).
- Multi-tenant taxonomies with org-specific severity policy.
- Reviewer productivity analytics (time-to-decision, disagreement hotspots).

---

## 9) Architecture principles for contributors

1. **Traceability before automation**: insights must be provable from source evidence.
2. **Human authority over model output**: AI suggests; reviewer decides.
3. **Boundary validation is non-negotiable**: reject malformed/unsafe model outputs.
4. **Schema evolution with replayability**: keep raw records and model metadata.
5. **Actionability over vanity metrics**: optimize for triage decisions, not chart volume.

---

## 10) Suggested repo evolution

```text
lib/
  analytics/
    compute-realtime-insights.ts
    compute-classification-kpis.ts
  classification/
    prompt.ts
    schema.ts
    report-summary.ts
    mapping.ts
  scrapers/
    index.ts
    providers/
      reddit.ts
      hackernews.ts
      github.ts

app/api/
  classify/
  classifications/
    route.ts
    stats/route.ts
    [id]/route.ts
  stats/
  issues/
  scrape/

docs/
  ARCHITECTURE.md
  DATA_QUALITY_RUNBOOK.md
  CLASSIFIER_GOVERNANCE.md
  API_CONTRACTS.md
```

This decomposition keeps ingestion, analytics, and reviewer-governed classification concerns isolated while preserving end-to-end provenance.
