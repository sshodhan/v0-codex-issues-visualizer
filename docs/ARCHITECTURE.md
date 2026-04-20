# Codex Issues Visualizer — Architecture Guide

_Last updated: 2026-04-20_

## 1) Purpose and product goals

This system collects public feedback about Codex/Copilot usage, classifies issues, and turns raw chatter into actionable engineering signals.

Primary goals:

1. **Detect what needs attention now** (short-term issue spikes, urgency ranking).
2. **Preserve historical signal quality** (trends, category breakdown, sentiment drift).
3. **Minimize noisy ingestion** (filter low-value/non-product matches).
4. **Support fast iteration** (clear extension points for sources, classifiers, and UI modules).

---

## 2) High-level architecture

```text
External Sources
  ├─ Reddit JSON API
  ├─ Hacker News Algolia API
  └─ GitHub Issues Search API
         │
         ▼
Scraper + Enrichment Layer (lib/scrapers/index.ts)
  ├─ relevance filtering (Codex-focused)
  ├─ normalization + low-value filtering
  ├─ sentiment scoring
  ├─ weighted category classification
  └─ deduplication
         │
         ▼
Supabase (Postgres)
  ├─ issues
  ├─ categories
  ├─ sources
  └─ scrape_logs
         │
         ▼
Next.js API Layer
  ├─ /api/issues  (query/filter issue rows)
  ├─ /api/stats   (dashboard aggregates + realtime insights)
  └─ /api/scrape  (trigger scraper run)
         │
         ▼
Dashboard UI (app/page.tsx)
  ├─ KPI cards
  ├─ charts (sentiment/source/category/trends)
  ├─ priority matrix
  ├─ realtime insights panel
  └─ issues table
```

---

## 3) Core runtime flows

## 3.1 Ingestion flow

1. A scrape is triggered manually (`/api/scrape`) or via cron route.
2. Scrapers fetch raw records from each provider.
3. Each candidate is cleaned and filtered:
   - whitespace normalization,
   - Codex relevance check,
   - low-value content exclusion (`[deleted]`, tiny titles, etc.).
4. Remaining records are enriched:
   - sentiment,
   - category assignment via weighted keyword scoring,
   - impact score.
5. Records are deduped and upserted to `issues` on `(source_id, external_id)`.
6. Scrape run status is recorded in `scrape_logs`.

## 3.2 Analytics flow

1. Dashboard loads `/api/stats` every minute.
2. API computes aggregate metrics:
   - totals,
   - sentiment/source/category breakdown,
   - 30-day trend,
   - priority matrix data.
3. API computes **realtime insights**:
   - recent 72h vs prior 72h category windows,
   - urgency score from volume + momentum + impact + negative ratio,
   - top issue samples for each hot category.
4. UI renders charts + ranked "what to fix now" guidance.

---

## 4) Module map and responsibilities

### 4.1 `lib/scrapers/index.ts`

Responsibilities:
- Source-specific fetching (Reddit/HN/GitHub).
- Cross-source normalization, relevance filtering, and dedupe.
- Lightweight NLP heuristics (sentiment + category scoring).
- Impact score derivation.

Extension guidance:
- Add new providers as isolated `scrapeX()` functions.
- Reuse shared helpers (`normalizeWhitespace`, relevance filters, classifier helpers).
- Keep provider-specific query syntax local to each scraper.
- Prefer explicit query grouping to avoid boolean precedence bugs.

### 4.2 `app/api/classify/route.ts`

Responsibilities:
- Build bounded classification context from report/env/tails/logs.
- Call OpenAI Responses API with strict JSON schema output.
- Enforce enum validation + `evidence_quotes` substring checks before acceptance.
- Apply hard human-review gates and optionally dual-write normalized + raw JSON.

Extension guidance:
- Keep schema versioned and backward compatible at the API boundary.
- Add reviewer override logging + few-shot rotation as separate workers.

### 4.2 `app/api/stats/route.ts`

Responsibilities:
- Aggregate dashboard metrics from `issues`.
- Build realtime urgency-ranked category insights.
- Normalize Supabase relation payload shape (`firstRelation`).

Extension guidance:
- Keep response backward-compatible for existing UI consumers.
- For heavy logic growth, extract analytics helpers to `lib/analytics/*`.
- Add versioning (`/api/stats?v=2`) before breaking response schema.

### 4.3 `hooks/use-dashboard-data.ts`

Responsibilities:
- Typed API contracts for dashboard consumers.
- SWR refresh cadence and stale data handling.

Extension guidance:
- Treat this as source-of-truth contract for UI typing.
- If response grows significantly, split into feature-specific hooks.

### 4.4 `components/dashboard/*`

Responsibilities:
- Visualize metrics and enable fast triage.
- Keep components presentational; push heavy transforms server-side.

Extension guidance:
- New insight modules should accept already-shaped data.
- Avoid embedding fetch logic inside visualization components.

---

## 5) Data model summary

Key tables:

- `sources`: configured data origins.
- `categories`: taxonomy for auto-classification.
- `issues`: canonical enriched issue records.
- `scrape_logs`: run status, counts, failures.

Important constraints:

- Unique issue key: `(source_id, external_id)`.
- `impact_score` bounded [1..10].
- `sentiment` constrained to positive/negative/neutral.

---

## 6) Classification and scoring strategy

## 6.1 Category assignment

Current model: weighted phrase matching with optional whole-word mode.

Why this exists:
- Improves over first-match substring logic.
- Allows stronger phrases to override weak incidental words.
- Supports category-specific weighting without model hosting overhead.

Future improvements:
1. Add confidence output (top-1 minus top-2 margin).
2. Route low-confidence to `other` or human review bucket.
3. Maintain evaluation set for precision/recall per category.

## 6.2 Realtime urgency scoring

Current score blends:
- recent volume,
- positive momentum (vs prior 72h),
- average impact,
- negative sentiment ratio.

Future improvements:
1. Add source diversity term (same issue across multiple sources).
2. Add time decay inside 72h window (newer issues weighted higher).
3. Add debiasing for repeated duplicates and repost chains.

---

## 7) Operational playbook

### 7.1 When data quality drops

Checklist:
1. Inspect `scrape_logs` for source-specific failures.
2. Validate source query changes (API syntax/rate-limit behavior).
3. Sample newest records for non-product noise leakage.
4. Re-tune relevance filters and category weights.

### 7.2 When realtime insights feel inaccurate

Checklist:
1. Inspect category window counts (now vs previous).
2. Verify negative ratio and impact computation inputs.
3. Check for dedupe misses causing inflated volume.
4. Compare top issue links against category label quality.

### 7.3 Key health metrics to track

- scrape success rate by source,
- ingestion precision (manual sampled relevance %),
- category precision/recall on labeled set,
- median time from scrape to dashboard availability,
- % of insights with at least one high-impact linked issue.

---

## 8) Future work roadmap

## Short-term (1-2 sprints)

- Extract analytics calculations into `lib/analytics` modules.
- Add explicit response schema tests for `/api/stats`.
- Add per-category confidence and uncertainty indicators.
- Add snapshot tests for realtime insight ranking.

## Medium-term (1-2 months)

- Introduce embedding-based semantic clustering for issue themes.
- Add anomaly detection for sudden surge alerts.
- Add source reliability weighting and spam heuristics.

## Long-term

- Hybrid classifier (rules + lightweight ML model).
- Feedback loop: human label corrections feeding automatic tuning.
- Multi-tenant workspace support with custom taxonomies.

---

## 9) Architecture principles for contributors

1. **Actionability over vanity metrics**: prefer metrics that change decisions.
2. **Server-side shaping**: keep heavy analytics in API layer.
3. **Deterministic heuristics first**: transparent scoring before opaque models.
4. **Backward compatibility by default**: evolve API contracts deliberately.
5. **Measure quality continuously**: every data-quality change should have a metric.

---

## 10) Suggested file/folder evolution

```text
lib/
  analytics/
    compute-realtime-insights.ts
    compute-dashboard-breakdowns.ts
  classifiers/
    category-scoring.ts
    sentiment-heuristics.ts
  scrapers/
    index.ts
    providers/
      reddit.ts
      hackernews.ts
      github.ts

docs/
  ARCHITECTURE.md
  DATA_QUALITY_RUNBOOK.md
  API_CONTRACTS.md
```

This split keeps concerns separate and lowers regression risk as feature velocity increases.
