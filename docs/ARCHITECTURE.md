# Codex Issues Visualizer — Architecture Guide

_Last updated: 2026-04-26 (v19 — Global Filter Bar moved below tabs; Topic filter now uses `categories.slug` from database to fix slug mismatch for special-character names like "UX/UI"; Top Families section moved from Dashboard to Triage tab with FREQUENT badge (threshold 5+ observations) and FIX FIRST badge (top actionability); HeroInsight filters by selected Topic. Previous: v18 — LLM category taxonomy v2 + reviewer subcategory override + classifier prompt restructure. The strict-schema `category` enum (`CATEGORY_ENUM` in `lib/classification/taxonomy.ts`) is rewritten from 12 hyphen-slug values to 14 snake_case values that map cleanly to LLM coding-agent failure modes (e.g. `code_generation_bug`, `autonomy_safety_violation`, `retrieval_context_mismatch` vs `incomplete_context_overflow`). New `CATEGORY_DEFINITIONS` (one-liner + `pick_when[]` + `not_when[]` per slug) and `SUBCATEGORY_EXAMPLES` (4–6 stable snake_case mechanism slugs per category) are typed `Record<IssueCategory, …>` so they cannot drift from the enum at build time. The classifier prompt (`lib/classification/prompt.ts`) renders both blocks dynamically — taxonomy edits in `taxonomy.ts` propagate automatically to the model contract, the prompt, and the UI label/palette map (`lib/classification/llm-category-display.ts`). Strict JSON schema's `alternate_categories.items.enum` now points at `CATEGORY_ENUM` (was `string[]` only), and `validateEnumFields` walks the array as a belt-and-braces guard for non-strict callers. Reviewer flow extended: `classification_reviews.subcategory` (new column via `scripts/020_classification_reviews_add_subcategory.sql`, additive nullable) lets reviewers override the LLM mechanism slug independently of category. The PATCH route, the storage RPC, the API queue join, the dashboard hook types, and the triage UI override form are all wired through; `effective_subcategory = latest?.subcategory ?? row.subcategory` follows the same pattern as `effective_category`. V1→v2 vocabulary remap: `scripts/019_migrate_llm_categories.sql` is the apply (run as the postgres role; service_role lacks UPDATE on `classifications` per migration 008). Snapshots affected rows into dated backup tables, runs the remap inside one transaction with a sanity check that `raise exception`s on incomplete remap, appends synthetic remap rows to `classification_reviews` for reviewer overrides on legacy slugs (does **not** UPDATE history), refreshes MVs after commit. `classifications.raw_json` is intentionally NOT mutated — it remains the verbatim model trace; only the column carries the v2 slug. `algorithm_versions.classification` is NOT bumped: this is a vocabulary rename, not an algorithm bump, and the read paths do not yet filter by `current_effective` (would double-count). Documented in `019`'s header. Replay caveat: `?as_of=T` queries against `classifications.category` for timestamps before the migration timestamp will reflect the v2 vocabulary post-migration. Prompt scaffolding gains: SUBCATEGORY GUIDANCE block with snake_case + 2–4 word + concrete-mechanism rules and a forbidden-vague-label list (`bug`, `issue`, `problem`, `failure`, `error`, `other` + `unknown_mechanism` fallback); EVIDENCE_QUOTES section stating the verbatim rule the pipeline already enforces post-hoc; TAGS vs SUBCATEGORY clarifier. 7 anchored few-shot examples (6 verbatim public bug reports with source URLs cited inline, 1 synthetic for the 3-way tool/env/plugin disambiguation that no public report cleanly demonstrates) + a USING THE EXAMPLES anti-bias guard that tells the model examples are tiebreakers, not templates, and to lower confidence + route to human review when the input doesn't fit any category cleanly. Rendered prompt grew from ~3.4K to ~4.9K tokens (cached on repeat calls). Stale UI strings in `components/dashboard/classification-triage.tsx` that named legacy slugs are now data-driven from `CATEGORY_ENUM.slice(0, 2)` so they cannot drift again. New tests/classifier-prompt.test.ts (12 tests) covers the runtime contract: every slug has a definition + ≥4 subcategory examples, prompt mentions every slug, HARD RULE 5 references `autonomy_safety_violation`, evidence rule includes "verbatim", legacy v1 slugs absent, exactly 7 worked examples with source URLs, USING THE EXAMPLES anti-bias guard present, alternate_categories enum-constrained. v17 — admin Classify-backfill panel gains scope-aware stats and an editable `MIN_IMPACT_SCORE` threshold. `GET /api/admin/classify-backfill` now accepts `?days=` (default 30, matches the dashboard banner) and `?minImpactScore=` (clamped to [0, 10]) and returns a five-count breakdown: at-threshold-windowed, at-default-windowed, all-impact-windowed, at-threshold-all-time, all-impact-all-time. `POST` accepts the same `minImpactScore` override so operators can experiment; the CRON path (`/api/cron/classify-backfill`) and the dashboard banner keep using the hardcoded `MIN_IMPACT_SCORE` default so ephemeral admin experiments never change system policy. Admin panel rebuilt with a Window selector (7/14/30/90/all-time), a numeric threshold input, a "Reset to default" button, a dry-run cost estimate (≈ $0.04/observation at gpt-5-mini rates), and a two-tier stats matrix — windowed counts that line up with the banner on top, all-time counts that line up with what "Run until done" processes below. `clampMinImpact` pure helper extracted to `lib/classification/run-backfill-constants.ts` so `node:test --experimental-strip-types` can unit-test the clamping invariants directly. v16 — V3 truth-first pass: the rollup response gained `severity_distribution` / `dominant_severity` / `sentiment_distribution` / `negative_sentiment_pct` / `surge_delta_pct` / `surge_window_hours` / `recent_window_count` / `prior_window_count` so the V3 card's state chips (CRITICAL / HIGH SEVERITY / SURGE DETECTED / NEEDS REVIEW), the Breaking Now big metric ("+340% 6h trend" or "new in 6h" or raw count fallback), and the "why surfaced" composed narrative are all backed by real aggregates rather than proxies. Three honesty gates are enforced server-side in `/api/clusters/rollup`: `dominant_severity` is null below `MIN_CLASSIFIED_SHARE_FOR_SEVERITY = 0.5`, `negative_sentiment_pct` is null below `MIN_CLUSTER_SIZE_FOR_SENTIMENT_PCT = 3`, `surge_delta_pct` is null below `MIN_PRIOR_WINDOW_FOR_SURGE = 3` (thresholds live in `lib/classification/rollup-constants.ts`). Pure composer `lib/classification/why-surfaced.ts` replaces the legacy 4-rule fixed-string decision tree with a template that renders only clauses whose underlying signal actually crossed threshold, with fallback to the legacy string when none do — so the UI never regresses and never fabricates. Surge window is **6 hours, aligned to the scrape cron cadence** (`0 */6 * * *` in `vercel.json`); shorter windows would just re-read the same MV snapshot twice. Deliberately dropped (documented in the plan file): "ESCALATING" chip, sentiment-momentum phrasing, "N escalating observations" phrasing, breadth synthesis ("All OS" / "Node.js Only") — each implies a measurement we don't take. v15 — production fix + V3 enrichment: migration `scripts/018_add_source_name_to_mv_observation_current.sql` adds `source_name` as a real column on `mv_observation_current` (via `left join sources s on s.id = o.source_id`) so `/api/clusters/rollup` and `/api/families/[clusterId]` stop 500'ing — the previous select relied on PostgREST auto-resolving the foreign-key column, which does not work on materialized views. Rebuilds `mv_trend_daily` and `mv_cluster_health_current` with it since both cascade-depend on the parent MV. V3 rollup response extended with `regex_variants`, `breadth`, `avg_impact`, `classified_share`, `human_reviewed_share` sourced from a bounded per-cluster fingerprint fan-out. Pipeline-state / prerequisites contract extended with `high_impact_pending_classification` so the dashboard banner no longer links reviewers to a classify-backfill CTA that is a no-op when every unclassified row sits below `MIN_IMPACT_SCORE = 6`; admin panel mirrors the split with a "total below-threshold not processed" sub-label. New reviewer-facing 5-stage observation trace at `app/observations/[id]/trace/page.tsx` consuming the existing public `/api/observations/[id]/trace` route — V3 card "View trace" no longer dead-ends on the admin-gated route. Server-side `logServerError` calls added to every 500 path in `/api/clusters/rollup` so production root-cause analysis has a trace. v14 — semantic-cluster chip strip sourced from a new `/api/clusters` route (reading `mv_observation_current` directly) so clusters render even when zero classifications exist yet. Adds `lib/classification/clusters.ts` → `aggregateClusters()` pure helper + `ClusterMemberPreview` UI that shows top-impact member observations when a chip is selected but the triage table is empty. v13 — AI triage pipeline-empty state replaced with a live prerequisite status panel. `/api/classifications/stats` accepts `?days=` and returns a `prerequisites` block (observations in scope, clustered count, classified count, OpenAI key configured, last scrape + last classify-backfill timestamps) computed via four parallel count queries against `mv_observation_current` and `scrape_logs`. Panel deep-links into `/admin?tab=classify-backfill` or `/admin?tab=clustering` (admin Tabs now honours `?tab=`) so reviewers can trigger the missing step without hunting for the right panel. Decision tree lives in `lib/classification/prerequisites.ts`. See `docs/CLUSTERING_DESIGN.md` §7. v12 — clustering vocabulary lock + Layer-A surfaced in triage UI: `/api/classifications` now returns `cluster_id`/`cluster_key`/`cluster_label`/`cluster_label_confidence`/`cluster_size` by joining `clusters` + `cluster_members` onto the observation; triage tab gains a "Top semantic clusters" chip strip and a detail-panel cluster block. "Category cluster focus" slider, "Top classification clusters" chips, "Clustered classification lanes" copy, and `clusterFilter` state were renamed to "Category focus" / "Top triage groups" / "Grouped classification lanes" / `groupFilter` so "cluster" means only Layer-A from here on; Vercel Analytics `cluster_filter` key preserved for back-compat. See `docs/CLUSTERING_DESIGN.md` §7. v11 — documents the built-in runtime error tracking layer (`lib/error-tracking/*`, `components/global-error-handler.tsx`, and `app/api/log-client-error/route.ts`) and clarifies client-vs-server logging flows. v10 — three-layer data model: evidence (append-only) + derivation (versioned, immutable) + aggregation (clusters + materialized views). Full schema rewrite: `issues` and `bug_report_classifications` tables removed in favor of `observations`/`observation_revisions`/`engagement_snapshots`/`ingestion_artifacts` + `sentiment_scores`/`category_assignments`/`impact_scores`/`competitor_mentions`/`classifications`/`classification_reviews` + `clusters`/`cluster_members`. Past dashboard readings are reproducible via derivation `computed_at <= T` filters. See `scripts/007_three_layer_split.sql` and `lib/storage/`. Supersedes PR #12 clustering edge cases (P1-9 through P1-12). v9 — issue-clustering / canonical-frequency data model documented, edge cases captured (PR #12); v8 — integrates with PR #11 urgency rework (sentiment weight in impact, not urgency) + `keyword_presence` signal; fallback-sentiment backchannel removed, full lexicon unification closes P0-2, window char-cap for unpunctuated blobs, summarizeCompetitiveMentions extracted, regex cache, re-export shim dropped; v7 — backward-compatible nullable sentiment, parameterized anchor brand, canonical competitor/lexicon modules, weighted meta, false-positive regression tests; v6 — mention-level competitive sentiment + transparency metrics; v5 — GitHub Discussions + OpenAI Community sources added; v4 — Stack Overflow source, competitive insights, data provenance section)_

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
  ├─ GitHub Issues Search API (REST)
  ├─ GitHub Discussions Search API (GraphQL)
  ├─ Stack Exchange (Stack Overflow) API
  └─ OpenAI Community (Discourse search.json)
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
  ├─ synthesizes classification report_text per new observation
  ├─ enqueues post-batch classification candidates (deduped by observation_id)
  ├─ classifies/persists each candidate via lib/classification/pipeline.ts
  └─ runScraper(slug) for single-source runs
         │
         ▼
Supabase (Postgres) — three-layer data model
  │
  ├─ Evidence layer (append-only, never UPDATE)
  │   ├─ observations             (per-source first sighting; fields frozen at capture)
  │   ├─ observation_revisions    (append on title/content change at rescrape)
  │   ├─ engagement_snapshots     (upvotes/comments time series)
  │   └─ ingestion_artifacts      (raw upstream JSON for replay)
  │
  ├─ Derivation layer (versioned per algorithm_version, immutable)
  │   ├─ sentiment_scores
  │   ├─ category_assignments
  │   ├─ impact_scores
  │   ├─ competitor_mentions      (materialized at enrich time, not query time)
  │   ├─ classifications          (LLM baseline; retries link via prior_classification_id)
  │   └─ classification_reviews   (append-only reviewer decisions)
  │
  ├─ Aggregation layer
  │   ├─ clusters                 (canonical_observation_id lives here, not on evidence)
  │   ├─ cluster_members          (detached_at IS NULL = active membership)
  │   └─ materialized views       (mv_observation_current, mv_trend_daily)
  │                                (refreshed on cron end via refresh_materialized_views())
  │
  └─ Reference tables (unchanged)
      ├─ sources, categories
      └─ scrape_logs
         │
         ├─ API: analytics/query layer
         │   ├─ /api/issues          (query/filter; supports q, days, source, sentiment, category, compound_key)
         │   ├─ /api/stats           (dashboard aggregates + realtime + competitive)
         │   ├─ /api/scrape          (trigger all scrapers)
         │   ├─ /api/scrape/[source] (trigger one scraper)
         │   ├─ /api/cron/scrape     (Vercel cron — every 6h)
         │   └─ /api/cron/classify-backfill (Vercel cron — daily 03:00 UTC)
         │
         └─ API: classifier/reviewer layer
             ├─ /api/classify
             ├─ /api/classifications          (baseline + latest review + observation traceability
             │                                 + semantic-cluster identity: cluster_id, cluster_key,
             │                                 cluster_label, cluster_label_confidence, cluster_size.
             │                                 See docs/CLUSTERING_DESIGN.md §7.)
             ├─ /api/classifications/stats    (aggregate queue KPIs + ?days=N pipeline
             │                                 prerequisites block for the triage empty-state panel)
             ├─ /api/classifications/:id (PATCH)
             ├─ /api/clusters                 (direct cluster read from mv_observation_current;
             │                                 independent of classifications so the chip strip
             │                                 renders even when zero classifications exist.
             │                                 Pure aggregation in lib/classification/clusters.ts.)
             └─ /api/observations/:id/classify  (GET = read latest, POST = force pass)
         │
         ▼
Analytics modules (lib/analytics/*)
  ├─ realtime.ts           (urgency = decayedVolume*1.6 + max(momentum,0)*1.4
  │                                    + avgImpact*1.0 + (sourceDiversity-1)*0.8;
  │                         sentiment weight lives in impact_score, not urgency —
  │                         see docs/SCORING.md)
  ├─ competitive.ts        (mention-window sentiment per competitor + confidence/coverage)
  ├─ competitors.ts        (canonical competitor keyword + display-name source of truth)
  └─ sentiment-lexicon.ts  (shared polarity/negator lexicon — dependency-free)
         │
         ▼
Dashboard UI (app/page.tsx)
  │
  ├─ Global Filter Bar (below tabs, applies to all tabs)
  │   ├─ Time filter (7d, 14d, 30d, All)
  │   └─ Topic filter (All + categories.slug values)
  │
  ├─ Dashboard Tab (V2 - Analytics/Exploration)
  │   ├─ HeroInsight (filtered by selected Topic)
  │   ├─ FingerprintSurgeCard
  │   ├─ Charts (Sentiment, Source distribution)
  │   ├─ PriorityMatrix + CategoryIssuesGrid
  │   └─ IssuesTable (deep-dive zone)
  │
  ├─ Triage Tab (V3 - Action/Decision)
  │   ├─ QuickStatsBar
  │   ├─ Top Families section (6 cards with badges)
  │   │   ├─ FREQUENT badge (amber) — top 3 by count, threshold: 5+ observations
  │   │   ├─ FIX FIRST badge (green) — top 3 by actionability_input
  │   │   └─ Actionability progress bar (red <34%, amber 34-66%, green >66%)
  │   ├─ Priority Rails (V3View - Fix Next, Breaking Now, Review Now)
  │   └─ IssuesTable
  │
  └─ AI Classifications Tab (reviewer workflow + LLM triage panel)
```

### API + UX contract (compound sub-cluster filter)

- **API:** `GET /api/issues` supports `compound_key` alongside `days`, `source`, and `sentiment`. It also supports optional `cluster_id` (UUID) to filter to Layer A semantic groupings from `mv_observation_current.cluster_id` (same for `as_of` replays, filtered in memory after the RPC). `compound_key` and `cluster_id` are mutually exclusive in the UI: applying one clears the other in the page URL.
- **Data semantics:** the compound-key filter is applied against `mv_observation_current.cluster_key_compound` (regex / fingerprint audit label). The cluster filter is applied against `cluster_id` (semantic clustering membership in the materialized view).
- **URL:** shareable deep links use `?fingerprint=<cluster_key_compound or err:…>` and `?cluster=<uuid>` (in addition to existing `?ux=`, `?as_of=`, and admin `?tab=`). The issues table, Story tab, and Classifications triage read these params so a cluster picked in Story can open the same scope in the table and in LLM triage.
- **UX behavior:** selecting error-code chips/buttons in the Issues Table or the Priority Matrix tooltip sets `?fingerprint=`; a dismissible chip is shown. Semantic cluster drill-downs set `?cluster=`. **Scope clarification:** these are read-time filters only; they do **not** alter semantic cluster membership.
- **Rollup:** `GET /api/clusters/rollup?days=&category=` returns top clusters by count in the window (from `mv_observation_current` with non-null `cluster_id`), with `label` / `label_confidence` from `clusters` and `classified_count` from `llm_classified_at` — used by the Story tab cluster list and the V3 prioritized-rails cards. Does not invent clusters. Extended in v15 with per-cluster enrichment joined from `mv_observation_current` fingerprint columns: `regex_variants` (top error codes / stack frames / env tokens / CLI versions), `breadth` (source-name counts + top OS tokens), `avg_impact`, `classified_share`, `human_reviewed_share`. The fingerprint enrichment fans out one extra `mv_observation_current` query against the top 50 cluster IDs capped at 2000 rows, ordered `(cluster_id, impact_score DESC)` so sampling is deterministic and biased toward high-signal observations. Extended in v16 with `severity_distribution` / `dominant_severity` / `sentiment_distribution` / `negative_sentiment_pct` / `surge_delta_pct` / `surge_window_hours` / `recent_window_count` / `prior_window_count` for the V3 state chips and Breaking Now surge metric. Two additional parallel count queries run alongside the fingerprint fan-out to compute the 6h / prior-6h window tallies. Each new field has a gating rule (see `lib/classification/rollup-constants.ts`) that returns `null` when the sample is too small to be honest — the UI treats `null` as "no statistic available" and falls back gracefully.

---

## 3) Runtime flows

### 3.1 Ingestion + enrichment flow

A scrape run is structured as three sequential passes over the captured records. Each pass writes to one layer only. The passes are independently replayable: re-running enrichment against existing evidence produces a new derivation row (stamped with a newer `algorithm_version`), never a mutation.

#### 3.1a Ingest (writes to evidence layer only)

1. A scrape is triggered manually (`/api/scrape`) or by cron route.
2. Source adapters fetch raw records; the full upstream response is captured in `ingestion_artifacts` keyed by `(source_id, external_id, fetched_at)`.
3. Candidates are cleaned and filtered (normalize whitespace, relevance, low-value exclusions).
4. Every surviving record is inserted into `observations` via `lib/storage/evidence.ts` → `recordObservation()` if unseen, else:
   - On title/content change vs. the current observation row → `recordRevision()` appends to `observation_revisions`.
   - On engagement change (upvotes, comments_count) → `recordEngagementSnapshot()` appends to `engagement_snapshots`.
5. `observations` rows themselves are never UPDATEd. OP edits, upvote changes, and deletion-at-upstream all land as new append-only rows; the original capture is preserved as evidence.
6. Run metadata is written to `scrape_logs`.

#### 3.1b Enrich (writes to derivation layer only)

1. For each observation touched in the ingest pass, the orchestrator computes the full set of derivations.
2. `analyzeSentiment` (`lib/scrapers/shared.ts`) → `lib/storage/derivations.ts` → `recordSentiment()` — writes one row to `sentiment_scores` stamped with the current sentiment algorithm version.
3. `categorizeIssue` → `recordCategory()` — writes to `category_assignments`.
4. `calculateImpactScore` → `recordImpact()` — writes to `impact_scores`, preserving the inputs (upvotes, comments, sentiment label) in `inputs_jsonb` so the score can be recomputed from the same captured evidence.
5. `scoreMentionSentiment` per competitor phrase (`lib/analytics/competitive.ts`) → `recordCompetitorMention()` — one row per mention window in `competitor_mentions`, stamped with `lexicon_version` + `algorithm_version`. This replaces the query-time recomputation that previously lived in `/api/stats`.
6. `extractBugFingerprint` (`lib/scrapers/bug-fingerprint.ts`) → `recordBugFingerprint()` — regex extraction of `error_code`, `top_stack_frame`, `cli_version`, `os`/`shell`/`editor`, `model_id`, `repro_markers`, `keyword_presence`. Produces a `cluster_key_compound` label (`title:<h>|err:<code>|frame:<fh>`) for audit; the label is display-only and does not drive cluster membership. See migration `013_bug_fingerprints.sql`.
7. Rescoring the entire corpus against a new algorithm is a normal insert job (insert derivation rows at version N+1); the old rows stay for reproducibility.

#### 3.1c Cluster (writes to aggregation layer only)

1. During per-issue ingest, we persist a semantic candidate payload (`id`, `title`, `content`, topic/error context) but **do not cluster yet**.
2. After the scrape loop completes, `runSemanticClusteringForBatch(...)` runs once over the full candidate batch for that run (post-loop batched clustering).
3. Semantic groups (`size >= minClusterSize`, default `2`) attach via semantic keys (`semantic:<digest>`); observations that fail embedding or remain singleton attach via deterministic title fallback.
4. Clustering failures are contained (logged + continue) so the scrape still reaches view refresh and the dashboard doesn't stay stale waiting for the next cron tick.
5. At the end of the scrape run, `/api/cron/scrape` calls the `refresh_materialized_views` RPC, which rebuilds `mv_observation_current` and `mv_trend_daily`. All dashboard reads pick up the new scrape after this step.

#### 3.1d Classify bridge (ingest → derivation classification)

1. `persistIssueRecord()` returns per-observation metadata (`observationId`, `title`, and a synthesized `reportText` payload) for newly captured observations.
2. After ingestion/evidence writes succeed, the orchestrator processes a post-batch queue through `processObservationClassificationQueue()` in `lib/classification/pipeline.ts`.
3. The queue applies a dedupe guard (`classifications.observation_id`) so already-classified observations are skipped by default; reclassification is opt-in policy.
4. Each candidate is classified by the same internal helper used by `/api/classify` (`classifyReport()`), avoiding server-side HTTP self-calls.
5. Failures are isolated per observation (the scrape run continues), emitted through the server logger with `component: "classification-pipeline"`, and surfaced in scrape error summaries.
6. The ingest queue only enqueues *newly captured* observations. The long tail (rows ingested before the classifier was wired up, or whose first attempt errored) is reached by a separate daily Vercel cron at `/api/cron/classify-backfill` (daily 03:00 UTC; sits between the 00:00 and 06:00 scrape ticks). It walks `mv_observation_current` for rows where `is_canonical = true AND llm_classified_at IS NULL AND impact_score >= 6`, sorts by `impact_score DESC, published_at DESC`, and routes the top N through the same `processObservationClassificationQueue()` helper with `reclassifyExisting: false`. Default cap is 10 canonicals/run (~$0.40/run at gpt-5-mini rates) so wall-clock fits under Vercel Hobby's 60s `maxDuration`; override with `?limit=` up to 100 on Pro plans. Run summary is written to `scrape_logs` with `source_id = NULL`; `/api/stats` explicitly excludes those rows from the "Last synced" chip so backfill runs don't masquerade as scrapes. See §3.5 for the full scheduled-jobs contract and `lib/classification/backfill-candidates.ts` for the pure mv-row → `ClassificationCandidate` projection (env/repro derivation goes through the shared helpers in `lib/classification/candidate.ts` so this path and `lib/scrapers/index.ts → buildClassificationCandidate` cannot drift).

#### 3.1.1 Clustering invariants

- **Clusters are stored separately from evidence.** Deleting or revising an observation never mutates cluster shape; the orchestrator explicitly detaches/reattaches via `cluster_members`.
- **Exactly one active canonical per cluster.** Enforced by `UNIQUE INDEX ON clusters(cluster_key)` plus a `canonical_observation_id` NOT NULL constraint. Canonical selection is a cluster property, not a flag on an observation.
- **Cluster membership is append-only per attach/detach event.** `detached_at IS NULL` is the active set; history is preserved.
- **`cluster_key` normalization lives in TypeScript only.** Since SQL never writes to `clusters`/`cluster_members` directly (only via the storage module), the former TS-vs-SQL hash parity requirement is obsolete.

### 3.2 LLM classification flow

1. The classifier is invoked in three places, all of which share the same reusable helper in `lib/classification/pipeline.ts` (`classifyReport`):
   - `/api/classify` (public) for external callers.
   - `processObservationClassificationQueue` inside the scraper orchestrator (`lib/scrapers/index.ts`) runs after every ingest batch so new observations are classified automatically (closes BUGS.md P1-7).
   - `/api/observations/[id]/classify` (on-demand) backs the SignalLayers UI — GET returns the latest persisted classification + regex fingerprint without a model call; POST forces a fresh classifier pass for the observation.
2. Server builds bounded context (`report_text`, env, repro, transcript/tool/log tails).
3. OpenAI Responses API is called with strict JSON-schema response format (`temperature: 0.2`).
4. If `confidence < 0.7`, the helper retries once on the larger model. Each retry inserts its own row into `classifications` with `prior_classification_id` pointing at the previous attempt — every LLM call is preserved as evidence of classifier drift and retry behavior.
5. Boundary validation runs:
   - enum validation,
   - `evidence_quotes` substring validation against request payload,
   - hard review rules (critical/safety/low confidence/sensitive mentions).
6. Output is returned and stored in `classifications` as normalized fields + raw JSON via `lib/storage/derivations.ts` → `recordClassification()`. Rows in `classifications` are immutable after insert.
7. **Relationship to `bug_fingerprints` (§3.1b #6).** The LLM classifier and the regex fingerprint run independently. No code path writes classifier output back to `bug_fingerprints` — `mv_observation_current` joins the latest `classifications` row per observation at MV-refresh time instead. This keeps each layer single-source-of-truth, removes denormalization drift, and makes the cluster-key label deterministic (regex only). The SignalLayers UI renders the two layers side-by-side: "Regex signals" from the fingerprint, "LLM insights" from `classifications`.

### 3.3 Reviewer flow

1. Dashboard fetches queue rows from `GET /api/classifications`. The endpoint returns the classification baseline joined to the most recent matching `classification_reviews` row so the queue shows effective state (post-review).
2. Dashboard fetches queue KPIs from `GET /api/classifications/stats` aggregated over the same join.
3. Reviewer selects a row, checks source-link traceability, and updates status / category / **subcategory** / severity / notes. Subcategory override (added in `scripts/020_classification_reviews_add_subcategory.sql`) lets the reviewer correct the LLM mechanism slug independently of category — e.g. AI says `code_generation_bug.logic_bug`, reviewer changes to `code_generation_bug.api_misuse`.
4. Dashboard sends patch to `PATCH /api/classifications/:id`.
5. The endpoint **inserts** a new row into `classification_reviews` (via `recordClassificationReview()`) — it never UPDATEs the classification. The LLM baseline stays immutable; every reviewer decision appends, preserving the full audit trail. A reviewer who changes their mind produces a second review row; the first is retained. `effective_category` and `effective_subcategory` resolve to the latest review row by `reviewed_at desc`, falling back to the baseline classification when no override exists.

### 3.4 Insight traceability flow

For any dashboard number, the analyst can walk the chain backwards:

1. **Dashboard widget** → the materialized view row it was sourced from (`mv_observation_current`, `mv_trend_daily`).
2. **Materialized view** → the derivation rows it aggregates, each stamped with `algorithm_version` and `computed_at`.
3. **Derivation row** → the `observations` row it was computed against, plus (for classifications) the `classification_reviews` that modified effective state.
4. **Observation** → the full capture chain: the first-sighting row, any `observation_revisions` entries (OP edits), `engagement_snapshots` over time, and the raw upstream payload in `ingestion_artifacts`.
5. **Upstream evidence** → the `url` field on the observation links back to the original Reddit / HN / GitHub / Stack Overflow / OpenAI Community post.

Past readings are reproducible: re-running any aggregate with `computed_at <= T` over the derivation layer yields exactly the numbers the dashboard showed at time T, regardless of later algorithm changes or reviewer overrides.

### 3.5 Scheduled jobs

The deployment runs two Vercel cron entries (configured in `vercel.json`). Both share the same auth contract (`Authorization: Bearer $CRON_SECRET`, fail-closed 503 in production when `CRON_SECRET` is unset, allow unauthenticated in non-prod for local dev) and both write run summaries to `scrape_logs`.

| Path | Cadence | What it does | `scrape_logs.source_id` | Kill switch |
|---|---|---|---|---|
| `/api/cron/scrape` | `0 */6 * * *` (every 6 h) | Fans out to every registered provider, persists evidence + derivations, attaches clusters, enqueues new observations through `processObservationClassificationQueue`, refreshes MVs. | non-null per provider | unset `CRON_SECRET` and disable in `vercel.json` |
| `/api/cron/classify-backfill` | `0 3 * * *` (daily 03:00 UTC) | Walks `mv_observation_current` for `is_canonical = true AND llm_classified_at IS NULL AND impact_score >= 6`, classifies up to `DEFAULT_LIMIT` (10) rows via the same queue with the dedupe guard, refreshes MVs. | NULL (distinguishes from scrape rows; `/api/stats` lastScrape filter excludes NULL `source_id`) | `CLASSIFY_BACKFILL_DISABLED=1` (preferred — does not break ingest classifier or SignalLayers Refresh) |

**Failure modes**
- Both routes set `maxDuration = 60` to fit Vercel Hobby; Pro plans clamp at 300.
- The classify-backfill cron's dedupe (`hasExistingClassification`) is a per-observation SELECT-then-INSERT, so two overlapping runs can race; the partial unique index needed to close that race conflicts with the large-model retry pattern (which writes a second row pointing back via `prior_classification_id`) — tracked as BUGS.md N-9.
- A run that exceeds `maxDuration` leaves a `status='running'` row in `scrape_logs` because `finalize()` never executes. Restart the cron tomorrow; the dedupe guard makes a re-run idempotent against already-classified observations.
- The "Last synced" header chip pulls from `scrape_logs WHERE source_id IS NOT NULL`, so backfill runs do **not** overwrite the ingest sync timestamp. Operators see backfill activity through `/admin` and the AI Classifications tab populating, not through the header.

**Operational checklist before enabling the schedule**
1. `CRON_SECRET` set in Vercel prod env (without it, both routes return 503).
2. `OPENAI_API_KEY` set in Vercel prod env (`/api/cron/classify-backfill` returns 503 without it).
3. `scripts/013_backfill_fingerprints.ts` has run against the corpus so observations have env/repro to thread into the classifier prompt.
4. `vercel.json` cron paths match the route paths exactly.

**Manual admin triggers**

The classify-backfill flow is also reachable from `/admin` for one-shot bulk runs — necessary because the cron's 10-obs/day cap is tuned for steady-state catch-up, not for clearing an initial backlog (10k rows at 10/day ≈ 3 years). The operator path shares the orchestrator (`lib/classification/run-backfill.ts → runClassifyBackfill`) with the cron but runs behind a different auth gate.

| Path | Auth | Owner | What it does |
|---|---|---|---|
| `/api/admin/classify-backfill` (GET) | `x-admin-secret: $ADMIN_SECRET` | `ClassifyBackfillPanel` in `app/admin/page.tsx` | Accepts `?days=` (default 30, matches the dashboard banner; `0`/`all` disables windowing) and `?minImpactScore=` (clamped to [0, 10]; absent falls back to the policy default). Returns `{ pendingCandidates, pendingCandidatesAllImpact, defaultLimit, maxLimit, minImpactScore, defaultMinImpactScore, openaiConfigured, window: { days, startIso }, counts: { atThresholdWindowed, atDefaultWindowed, allImpactWindowed, atThresholdAllTime, allImpactAllTime } }` so the panel can render a scope-aware matrix that lines up with the banner on top and with "Run until done" semantics below. |
| `/api/admin/classify-backfill` (POST) | `x-admin-secret: $ADMIN_SECRET` | `ClassifyBackfillPanel` | Runs one batch through `runClassifyBackfill`. Body: `{ limit?: 1..100, refreshMvs?: true, dryRun?: false, minImpactScore?: 0..10 }`. `minImpactScore` is clamped server-side; when omitted, the default `MIN_IMPACT_SCORE` from `lib/classification/run-backfill-constants.ts` applies (so the daily cron path is unchanged). `dryRun` returns a count + budget preview with no model calls. The "Run until done" loop pages batches with `refreshMvs: false` on intermediate calls and `true` on the final one so MVs are rebuilt once per catch-up rather than once per batch. |

Both routes write run rows to `scrape_logs(source_id = NULL)` so admin activity is visible in the same audit history as cron activity. Auth boundaries are distinct: `CRON_SECRET` gates Vercel's scheduler surface; `ADMIN_SECRET` gates operator actions from `/admin`. The orchestrator is shared; the auth is not. Also tracked: BUGS.md N-9 documents a dedupe SELECT-INSERT race that grows wider when an admin "Run until done" loop overlaps the 03:00 UTC cron tick — the panel description warns operators to avoid that overlap.

---

## 4) Module map and responsibilities

### 4.1 `lib/scrapers/`

Layout:
- `lib/scrapers/index.ts` — orchestrator. `runAllScrapers()` (parallel) and
  `runScraper(slug)` (single-source). Owns `scrape_logs` lifecycle and runs the
  ingest/enrich/cluster flow plus post-batch classification enqueue/processing,
  delegating every write to
  `lib/storage/{evidence,derivations,clusters}.ts`. Does not touch the database
  directly.
- `lib/scrapers/shared.ts` — pure functions consumed by the enrich pass:
  relevance filter (delegates to `relevance.ts`), sentiment classifier
  (`analyzeSentiment` → returns `{ sentiment, score, keyword_presence }` which
  is now fully consumed by `recordSentiment()`), category scoring
  (`categorizeIssue`), impact scoring (`calculateImpactScore`), competitor
  keyword detection. All word lists come from `lib/analytics/sentiment-lexicon.ts`
  and `lib/analytics/competitors.ts`. `buildIssueClusterKey` +
  `normalizeTitleForCluster` have moved to `lib/storage/clusters.ts` (see §4.7).
  See `docs/SCORING.md` for the current signal contract.
- `lib/scrapers/bug-fingerprint.ts` — deterministic regex extractor that
  produces a `BugFingerprint` (error code, top stack frame + line-stable
  hash, CLI version, OS/shell/editor, model id, repro markers,
  keyword_presence). `buildCompoundClusterKey(title, fingerprint)`
  produces a display/audit label (`title:<h>|err:<code>|frame:<fh>`)
  that is persisted on `bug_fingerprints.cluster_key_compound` — it does
  NOT drive physical cluster membership. The key is pure regex: the LLM
  classifier never contributes to it, so cluster-key derivations stay
  deterministic and replayable. See migration `013_bug_fingerprints.sql`.
- `lib/scrapers/providers/{reddit,hackernews,github,github-discussions,stackoverflow,openai-community}.ts` —
  one provider per file. Each owns its source-specific query and mapping into
  a `CapturedRecord` shape (evidence-layer fields only). `github-discussions`
  and `openai-community` cover the high-signal channels that the REST `github`
  scraper and the news/Q&A providers miss.

### 4.7 `lib/storage/`

The only module allowed to write to the database. Enforces the three-layer boundary at the module level; complements the DB-level RLS grants described in §5.6.

- `evidence.ts` — `recordObservation(record)`, `recordRevision(observationId, changes)`, `recordEngagementSnapshot(observationId, upvotes, comments)`, `recordIngestionArtifact(key, payload)`. All calls go through `SECURITY DEFINER` RPCs; no direct table writes.
- `derivations.ts` — `recordSentiment(observationId, result)`, `recordCategory(observationId, categoryId, confidenceProxy, evidence?)`, `recordImpact`, `recordCompetitorMention`, `recordBugFingerprint(observationId, payload)`, `recordClassification(payload, priorId?)`, `recordClassificationReview(classificationId, review)`. Each pulls the current `algorithm_version` from `algorithm-versions.ts` and stamps the row. `recordCategory`'s `evidence` arg is the full `TopicEvidence` JSONB returned by `categorizeIssue`; persisted into `category_assignments.evidence` (added in `scripts/026_category_assignments_evidence.sql`) so admin debugging can answer "why did this row classify as X?" with a single SQL query (see §5 for the evidence shape). `recordBugFingerprint` only takes regex-derived signals — the LLM classifier's output is not denormalized onto `bug_fingerprints` (see §3.2).
- `clusters.ts` — `attachToCluster(observationId, title)`, `detachFromCluster(observationId)`, `promoteCanonical(clusterId)`. Owns `buildClusterKey` + `normalizeTitleForCluster` (migrated from `lib/scrapers/shared.ts`). Since SQL no longer writes to clusters, the old TS↔SQL hash-parity requirement is obsolete.
- `algorithm-versions.ts` — central `CURRENT_VERSIONS` registry (the single source of truth for the derivation version every enrich pass stamps on its writes). Current state: `sentiment: "v2"`, `category: "v6"` (bumped 2026-04 in `scripts/027_topic_classifier_v6_bump.sql` — phrase-table maintenance pass after v5 low-margin evidence review: adds coding-agent vocabulary for `developerInstructions`, merge/branch conflicts, progress-log visibility, `higher limits` / `priority processing`, `model does not appear` (bounded), workspace-write/bubblewrap sandbox + device passthrough, ANSI escape injection (bounded phrases only), and `additionalContext` / `PreToolUse` intent distinctions (entity-vs-mechanism — support/add → feature-request, ignored/not used → model-quality, missing/not passed in hook payload → integration, crashes → bug) with `bypass the approval prompt` at w5 to outscore ux-ui `approval prompt` w4; removes weak `how to` documentation phrase. No scoring algorithm changes — `SLUG_THRESHOLD` stays empty, title/body 4× split + template-prefix stripping + structured evidence emission carry over from v5. Predecessor v5 (2026-04, `scripts/025` + `scripts/026`) was the structural classifier refactor: title and body scored separately with title weighted 4×, `[BUG]`/`[FEATURE]`/… template prefixes stripped before phrase matching and the stripped prefix captured in evidence, per-slug threshold mechanism wired but intentionally left empty in v5 (default floor 2 for all slugs; threshold tuning deferred until backfill evidence shows need), and `categorizeIssue` now returns `TopicResult { categoryId, slug, confidenceProxy, evidence }` where `confidenceProxy` is a deterministic score-margin ratio and `evidence` is a self-describing JSONB with `algorithm_version`, `classifier_type`, `input` (title/body presence + template info), `scoring` (multipliers, thresholds, per-slug scores, winner, margin, `confidence_proxy`), and `matched_phrases` (each carrying `slug`, `phrase`, `pattern_weight`, `effective_weight`, `location`, `raw_hits`, `weighted_score`). Evidence is persisted into a new `category_assignments.evidence` column (see §5) for SQL-side classification audits. Earlier predecessors: v4 (2026-04, `scripts/024`) expanded coding-agent regex coverage; v3 (2026-04, `scripts/023`) added the `model-quality` slot and tightened Pricing), `impact: "v2"`, `competitor_mention: "v2"` (impact + sentiment + competitor_mention were bumped together in `scripts/011_algorithm_v2_bump.sql` after the eye-test tuning), `classification: "v1"`, `observation_embedding: "v1"` (shipped in `scripts/012_semantic_clustering.sql`), `semantic_cluster_label: "v2"` (bumped 2026-04 alongside the deterministic-fallback labeller — see `docs/CLUSTERING_DESIGN.md` §4.4), `bug_fingerprint: "v1"` (shipped in `scripts/013_bug_fingerprints.sql`). Bumping here is the only way to trigger a new derivation row shape — the registry file is authoritative; 007's seed + delta migrations (011+) must stay consistent with it. The schema-verifier manifest in `lib/schema/expected-manifest.ts` carries the same expected versions; `tests/algorithm-version-manifest-contract.test.ts` fails the build if either half drifts.
- `cluster-label-fallback.ts` — pure helper for the deterministic Topic+error fallback in the `semantic_cluster_label` v2 pipeline. Exports the typed `LABEL_MODEL` const-object that catalogues every value the labeller can write to `clusters.label_model` (four `deterministic:*` rungs, plus an `OPENAI_PREFIX` builder for LLM tags and a `LEGACY_FALLBACK_TITLE` reference for the v1 stub the backfill upgrades from). Also exports `MIN_DISPLAYABLE_LABEL_CONFIDENCE` — the single source of truth shared by the producer's lowest write rung and every UI render site, so the producer/consumer threshold contract cannot silently drift. See `docs/CLUSTERING_DESIGN.md` §4.4.

### 4.8 `lib/classification/`

- `pipeline.ts` — shared server-side classification executor used by `/api/classify`, `/api/observations/:id/classify`, scraper orchestration, and the daily classify-backfill cron. Owns: model-call/retry policy, hard review-rule application, enum/evidence validation, dedupe checks against existing `classifications` rows, and per-observation failure logging.
- `candidate.ts` — dependency-free types and pure helpers shared by every callsite that builds a `ClassificationCandidate`: `synthesizeObservationReportText`, `buildEnvFromFingerprintColumns`, `buildReproFromFingerprintMarkers`. Kept dependency-free so node:test can import it without resolving `@/*` aliases (see Testability invariant in §4.1). Both the ingest-time builder (`lib/scrapers/index.ts → buildClassificationCandidate`) and the backfill builder (`lib/classification/backfill-candidates.ts → buildBackfillCandidates`) call these helpers — single source of truth for the classifier env/repro contract.
- `backfill-candidates.ts` — pure projection from `mv_observation_current` row shape to `ClassificationCandidate`, used by both `/api/cron/classify-backfill` (daily) and `/api/admin/classify-backfill` (operator one-shot). The mv renames the fingerprint os/shell/editor columns to `fp_*` to avoid collisions with observation-level columns; this module rewires them at the boundary.
- `run-backfill.ts` — shared orchestrator (`runClassifyBackfill`, `countBackfillCandidates`) that owns the `mv_observation_current` query → `buildBackfillCandidates` → `processObservationClassificationQueue` → MV-refresh sequence. The cron route and the admin route each own their own auth + `scrape_logs` lifecycle and delegate the orchestration here. `refreshMvs: false` lets the admin "Run until done" loop skip intermediate MV rebuilds so a 10-batch catch-up triggers one refresh, not ten.
- `run-backfill-constants.ts` — dep-free constants (`MIN_IMPACT_SCORE`, `BACKFILL_SELECT_COLS`) extracted so `tests/run-backfill.test.ts` can pin them without resolving the `@/*` alias graph. See the Testability invariant below.
- `taxonomy.ts` — canonical LLM-side enum constants (`CATEGORY_ENUM`, `SEVERITY_ENUM`, etc.). Note: the LLM `CATEGORY_ENUM` is intentionally disjoint from the heuristic `categories.slug` namespace populated by `lib/scrapers/shared.ts → categorizeIssue`. Two separate taxonomies, two separate UI surfaces (heuristic on the dashboard tab, LLM on the AI Classifications tab); `components/dashboard/classification-triage.tsx` carries an explicit guard so a heuristic global-category filter doesn't silently empty the LLM tab.
- `taxonomy.ts`, `mapping.ts`, `prompt.ts`, `report-summary.ts`, `schema.ts` — supporting modules for the `pipeline.ts` model call (enum lists, output schema, prompt assembly, request payload).

Extension guidance:
- Add a new provider by creating `providers/<slug>.ts` and registering it in
  the `SCRAPERS` map in `index.ts`. Add the matching `sources` row via a
  numbered SQL migration.
- Reuse shared helpers (`normalizeWhitespace`, `analyzeSentiment`,
  `categorizeIssue`, `fetchWithRetry`). `analyzeSentiment` and any future
  sentiment consumer MUST import polarity words from
  `lib/analytics/sentiment-lexicon.ts` — never inline a copy. Inline word
  lists that disagree with the canonical set are how P0-2 and the
  mention-vs-ingest drift happened historically.
- Keep provider-specific query syntax local to each provider.
- Prefer explicit query grouping (or `optionalWords`-style boolean OR) to
  avoid boolean precedence bugs.

Testability invariant:
- Any `lib/scrapers/*.ts` file that is imported by a `*.test.ts` file must
  use relative (`./`, `../`) imports, not `@/` aliases — the `node --test
  --experimental-strip-types` runner does not resolve the `@/` path mapping.
  Files not reached by a test can continue to use `@/`. When a test is
  added that transitively loads a new source file, convert that file's
  external imports to relative form. See `relevance.ts`, `shared.ts`,
  `competitive.ts`, `competitors.ts`, `sentiment-lexicon.ts` for the
  established pattern.

### 4.2 `app/api/stats/route.ts`

Responsibilities:
- Aggregate KPI + trend + realtime urgency metrics from `issues`.
- Pull a single 6-day window once and feed both realtime and competitive
  analytics from it (avoids duplicate queries).
- Normalize Supabase relation payload shape (`firstRelation`).
- Feed the Priority Matrix from canonical rows only (`is_canonical = true`)
  so cluster frequency is surfaced without double-counting duplicates.
- **LLM category breakdown (Story / honest cross-compare):** the same filtered
  canonical row set also rolls up `llm_category` from `mv_observation_current`
  (latest classification join) when `llm_classified_at` is set, exposed as
  `llmCategoryBreakdown`, `llmClassifiedInWindow`, and `llmPendingInWindow` on
  the JSON response. This is **not** the same as `classificationStats.byCategory`
  (which counts raw `classifications` rows without the MV time slice). The
  Classifications tab can scope triage via `?llm_category=<slug>` (and optional
  `?triage_group=<effective_category › subcategory>` URL-encoded).

**Canonical-filter policy (open gap).** The Priority Matrix is canonical-
filtered, but the other aggregates in this route (`totalIssues`,
`sentimentBreakdown`, `sourceBreakdown`, `categoryBreakdown`, `trendByDay`,
`realtimeInsights`, `competitiveMentions`) and `/api/issues` still query the
full `issues` table. Until the filter policy is unified, the Priority Matrix
and the rest of the dashboard count differently. Resolve by either applying
`is_canonical = true` uniformly or by weighting by `frequency_count` in
aggregations — see `docs/BUGS.md`.

Heavy analytics live in `lib/analytics/*`:
- `lib/analytics/realtime.ts` — urgency-ranked category insights with
  source diversity and recency decay.
- `lib/analytics/competitive.ts` — mention-level sentiment scoring,
  per-issue aggregation, per-competitor confidence/coverage metrics, AND the
  payload summarizer `summarizeCompetitiveMentions`. The API route is a
  thin caller; all aggregation math lives here so per-competitor shape
  changes and meta aggregation stay in one file.
- `lib/analytics/competitors.ts` — canonical `COMPETITOR_KEYWORDS` and
  `COMPETITOR_DISPLAY_NAMES`. **Display names are never derived into detection
  phrases** — doing so is a proven false-positive source (e.g. stripping
  trailing " Code" from "Sourcegraph Cody" would match the bare string
  "sourcegraph"). Detection is driven exclusively by `COMPETITOR_KEYWORDS`.
- `lib/analytics/sentiment-lexicon.ts` — the single source of truth for
  `POSITIVE_WORDS`, `NEGATIVE_WORDS`, and `NEGATORS`. **Every** sentiment
  consumer in the app imports from here — the mention-window classifier in
  `competitive.ts` and the ingest-time classifier in `shared.ts`. No inline
  word lists are permitted anywhere else; that path produced P0-2 and the
  mention-vs-ingest drift that the senior review flagged. Topic nouns
  ("bug", "error", "issue", "problem", "fail") are deliberately absent.

Extension guidance:
- Keep response backward-compatible for existing UI consumers.
- Add new metrics as additional analytics modules called from the route.
- Add versioning (`/api/stats?v=2`) before breaking response schema.
- When adding a metric backed by a new analytics module, co-locate its
  summarizer with the module (as `summarizeCompetitiveMentions` is
  co-located). Do not inline reduce-chains in the API route — the code
  review history shows this accumulates drift.

Competitive payload details (current contract):
- `competitiveMentions[*]` carries `totalMentions` (issues), `rawMentions`
  (per-mention count across those issues), `scoredMentions` (mentions whose
  window had at least one valence token), `coverage` (= `scoredMentions /
  rawMentions`), `avgConfidence` (mean confidence **over scored mentions
  only**), and `netSentiment` (mean score over scored mentions only). Issues
  with only zero-evidence windows contribute to `totalMentions`/`rawMentions`
  but do not dilute sentiment, confidence, or positive/negative/neutral
  counters.
- `topIssues[*].sentiment` is `"positive" | "negative" | "neutral" | null`.
  `null` is preserved when every window in the issue was evidence-free.
  The ingest-time `issue.sentiment` is **never** substituted as a fallback
  for a zero-evidence window — doing so would re-introduce P0-4 through a
  side channel (a post dominated by anti-anchor sentiment that merely
  name-drops a competitor would otherwise inherit that negative signal).
- `/api/stats` returns `competitiveMentionsMeta` (= the output of
  `summarizeCompetitiveMentions`) with `competitorsTracked`,
  `mentionCoverage` (= `Σ scoredMentions / Σ rawMentions`, weighted by
  mention volume), `avgConfidence` (= `Σ (avgConfidence × scoredMentions) /
  Σ scoredMentions`, weighted by mention volume), and `totalScoredMentions`.
  Unweighted arithmetic means across competitors were actively misleading —
  a single one-mention competitor could drag the dashboard KPI.

Competitive scoring invariants (enforced by `lib/analytics/competitive.test.ts`):
- **Bounded sentence window.** Each mention is scored on the text between
  the nearest sentence-ending punctuation (`.`, `!`, `?`, `\n`) on either
  side, **capped at `MAX_WINDOW_CHARS = 280` per side**. The cap prevents
  unpunctuated social-media blobs from collapsing the window back to
  "score the entire post." Earlier revisions padded ±120 chars beyond the
  sentence bounds; that reintroduced cross-sentence leakage and was
  removed.
- **Canonical-phrase detection only.** No display-name derivation, no
  trailing-word stripping. `getDetectionPhrases`-style rules are forbidden.
- **Word-boundary-safe mention matching.** Alphanumerics on either side of
  the phrase defeat a match (so `myCursorHelper` does not match).
- **Negation lookback is bounded.** Three tokens — far enough for `"not
  bad"` / `"never great"`, tight enough to keep `"it is not the case that
  ... said great"` from flipping.
- **Comparative anchor is parameterized and escaped.**
  `computeCompetitiveMentions(..., { anchorBrand })` controls which brand
  is used as the `/(better|worse)\s+than\s+<anchor>/` comparative target.
  Defaults to `"codex"`. The anchor is run through `escapeRegExp` so it is
  safe for callers passing arbitrary strings (including regex
  metacharacters). Regexes are cached per anchor to avoid reconstruction
  per call.
- **No ingest-sentiment fallback.** `scoreMentionSentiment` and
  `aggregateCompetitorSentimentForIssue` return `sentiment: null` for
  evidence-free windows. `computeCompetitiveMentions` does not thread
  `issue.sentiment` through — intentionally, to prevent the P0-4
  side-channel recurrence. If you need to surface "we saw the mention but
  had no signal," read `scoredMentions === 0` and render "no signal" in
  the UI.

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

The schema is organized in three layers with strict write direction: scrapers write to evidence only, enrichment writes to derivation only, clustering and materialized views write to aggregation only. All read paths for the dashboard go through the aggregation layer.

### 5.1 Evidence layer (append-only, never UPDATE)

The only layer that captures raw upstream data. Every row is immutable after insert. The append-only invariant is enforced at the DB layer by withholding UPDATE grants from the service_role and routing all writes through `record_*` RPCs.

- `observations`: first-sighting capture of a post from a public source.
  - `id UUID PK`, `source_id UUID`, `external_id TEXT NOT NULL`, `title TEXT`, `content TEXT`, `url TEXT`, `author TEXT`, `published_at TIMESTAMPTZ`, `captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`.
  - UNIQUE `(source_id, external_id)`.
  - No sentiment/impact/category columns — those live in the derivation layer, keyed by `observation_id`.
- `observation_revisions`: append-only log of title/content/author changes detected at rescrape.
  - `(observation_id, revision_number, title, content, author, seen_at)`.
  - The original `observations.title`/`content` are never overwritten; revisions accumulate here.
- `engagement_snapshots`: append-only time series of `upvotes` and `comments_count`.
  - `(observation_id, upvotes, comments_count, captured_at)`.
  - Dashboards read the latest snapshot; trend analyses read the series.
- `ingestion_artifacts`: raw upstream API response stored as `jsonb` (or `bytea` gzipped for large payloads), keyed by `(source_id, external_id, fetched_at)`. Enables full replay of enrichment and clustering against captured evidence without re-hitting upstream APIs.

### 5.2 Derivation layer (versioned, immutable)

Every derived signal is a row stamped with `algorithm_version` and `computed_at`. Algorithm changes insert new rows at version N+1; old rows stay for reproducibility. Rescore migrations become normal insert jobs, not table rewrites.

- `sentiment_scores (observation_id, algorithm_version, score NUMERIC(4,3), label TEXT, keyword_presence INT, computed_at)`.
- `category_assignments (observation_id, algorithm_version, category_id, confidence NUMERIC(3,2), evidence JSONB, computed_at)`. `evidence` (added in `scripts/026`) carries the v5+ regex matcher's self-describing output: `{ algorithm_version: "v6", classifier_type: "regex_topic", input: { title_present, body_present, template_prefix, template_stripped }, scoring: { title_multiplier, body_multiplier, default_threshold, slug_thresholds, scores{slug→int}, winner, runner_up, margin, threshold, confidence_proxy }, matched_phrases[{ slug, phrase, pattern_weight, effective_weight, location: "title"|"body", raw_hits, weighted_score, whole_word? }] }`. Nullable — pre-v5 rows persist with NULL. The `confidence` column stores `TopicResult.confidenceProxy` (a deterministic score-margin ratio, not a calibrated probability).
- `impact_scores (observation_id, algorithm_version, score INT, inputs_jsonb JSONB, computed_at)` — `inputs_jsonb` records the engagement inputs at compute time so the score is verifiable from captured evidence alone.
- `competitor_mentions (observation_id, competitor TEXT, sentence_window TEXT, sentiment_score NUMERIC(4,3), confidence NUMERIC(3,2), lexicon_version TEXT, algorithm_version TEXT, computed_at)` — one row per mention window. Replaces the query-time recomputation in `lib/analytics/competitive.ts`.
- `classifications`: LLM classifier baseline, immutable after insert.
  - All existing fields (`category`, `severity`, `confidence`, `summary`, `evidence_quotes`, `raw_json`, etc.).
  - `prior_classification_id UUID NULL REFERENCES classifications(id)` — when small-model confidence < 0.7 triggers a retry, the large-model row references the small-model attempt. Both are retained.
  - `observation_id UUID REFERENCES observations(id)` — replaces `source_issue_id` for cleaner traceability naming.
- `classification_reviews`: append-only reviewer decisions.
  - `(id, classification_id, status, category, severity, needs_human_review, reviewer_notes, reviewed_by, reviewed_at)`.
  - A reviewer who revises their decision inserts a second row; the first remains for audit.
  - Effective state for a classification is the most recent review (subquery `ORDER BY reviewed_at DESC LIMIT 1`).
- `bug_fingerprints (observation_id, algorithm_version, error_code, top_stack_frame, top_stack_frame_hash, cli_version, os, shell, editor, model_id, repro_markers, keyword_presence, cluster_key_compound, computed_at)` — deterministic regex extractor output (migration `013_bug_fingerprints.sql`). Written by `lib/scrapers/index.ts` on every ingest. Immutable per `(observation_id, algorithm_version)`. `cluster_key_compound` (`title:<h>|err:<code>|frame:<fh>`) is a *display/audit* label — physical clustering is owned by the semantic pass (§5.3). The LLM classifier's output is NOT denormalized here; `mv_observation_current` joins `classifications` directly so there is exactly one source of truth per layer (regex here, LLM there).
- `observation_embeddings` — see migration `012_semantic_clustering.sql`; feeds semantic cluster attachment.

### 5.3 Aggregation layer

The only layer consumed by the dashboard API routes. Every row can be rebuilt from derivation + evidence.

- `clusters (id UUID PK, cluster_key TEXT NOT NULL UNIQUE, canonical_observation_id UUID NOT NULL, status TEXT, created_at TIMESTAMPTZ)`.
- `cluster_members (cluster_id, observation_id, attached_at, detached_at)` with a partial unique index `(cluster_id, observation_id) WHERE detached_at IS NULL` so an observation can belong to at most one active cluster.
- Materialized views (refreshed by `refresh_materialized_views()` at `/api/cron/scrape` run end):
  - `mv_observation_current` — one row per active cluster-canonical observation joined to the latest derivation rows and the latest engagement snapshot. Backs `/api/issues`, the Priority Matrix, and `/api/stats` (which computes sentiment / source / category breakdowns in one scan of the canonical set).
  - `mv_trend_daily` — date-bucketed sentiment counts for the trend chart.
- `frequency_count` is no longer a column; it is a view:
  ```sql
  CREATE VIEW cluster_frequency AS
  SELECT cluster_id, COUNT(*) AS frequency_count
  FROM cluster_members WHERE detached_at IS NULL GROUP BY cluster_id;
  ```

### 5.4 Reference tables (unchanged)

- `sources`, `categories` — lookup tables, seeded once.
- `scrape_logs` — ingestion run metadata and failures.

### 5.5 Key indexes and constraints

- `observations (source_id, external_id)` UNIQUE — first-sighting dedup.
- `observations (published_at DESC)` — trend / 6-day window queries via MVs.
- `engagement_snapshots (observation_id, captured_at DESC)` — latest-snapshot lookups.
- `sentiment_scores (observation_id, algorithm_version, computed_at DESC)` — latest-version lookups; same shape for `category_assignments`, `impact_scores`.
- `competitor_mentions (competitor, computed_at DESC)` — per-competitor rollups.
- `clusters (cluster_key)` UNIQUE — one cluster per normalized title key.
- `cluster_members (cluster_id, observation_id) WHERE detached_at IS NULL` UNIQUE — one active membership per observation.
- `classifications (observation_id, created_at DESC)` — per-observation LLM history.
- `classification_reviews (classification_id, reviewed_at DESC)` — effective-state lookup.
- `classifications (category, severity, needs_human_review, created_at DESC)` — triage queue filter.

### 5.6 Append-only enforcement

The RLS policy for `service_role` grants INSERT but NOT UPDATE/DELETE on `observations`, `observation_revisions`, `engagement_snapshots`, `ingestion_artifacts`, `classifications`, `classification_reviews`. Writes flow through `record_*` RPCs defined with `SECURITY DEFINER` — these are the only way to land a row and they validate shape before insert. Attempts to UPDATE evidence fail at the DB, not at the application, so a buggy scraper cannot corrupt the evidence layer.

### 5.7 Fingerprint time-series MV

`scripts/014_fingerprint_trend.sql` adds a read-optimized time-series surface
for regex-extracted error codes so the dashboard can answer "is something
breaking right now?" without scanning `bug_fingerprints` on every request.

- `mv_fingerprint_daily(day, error_code, cnt, source_diversity)` — 60-day
  daily buckets built from `bug_fingerprints` ⨝ `observations` ⨝ `sources`.
  One row per `(day, error_code)`. `source_diversity` is the distinct
  source count on that day, so cross-source amplification is visible
  without another join at read time. Indexed on `(error_code, day desc)`
  and `(day desc)` so the surge function hits an index on every run.
- `v_cluster_source_diversity(cluster_id, source_diversity)` — companion
  view (not materialized) that projects per-cluster source diversity off
  `mv_observation_current`. Feeds the 7% `source_diversity` term in the
  actionability score (see `docs/SCORING.md` §10.1).
- `fingerprint_surges(window_hours int default 24)` — read-time SQL
  function returning `(error_code, now_count, prev_count, delta, sources)`
  for the dashboard surge card and alerting UI. Buckets at day
  granularity; delta > 0 qualifies as a surge; `prev_count = 0` with
  `now_count > 0` is the "new in window" signal consumed by
  `lib/analytics/fingerprint-surge.ts`.

Refresh semantics:

- `refresh_materialized_views()` is extended in place to refresh
  `mv_observation_current` (CONCURRENTLY, has a unique index),
  `mv_trend_daily`, and `mv_fingerprint_daily` together at cron end.
  No scheduling changes — the scraper pipeline already calls the RPC
  after every ingest batch (`lib/scrapers/index.ts`).
- No write path to `bug_fingerprints` changes in this migration; the
  append-only invariants from 013 remain intact.
- No `algorithm_version` bump — no derivation shape changed.
- Surge detection is a read-time SQL function, not a new write
  pipeline or denormalized table.

Invariants preserved:

- `mv_observation_current` is NOT dropped or rebuilt; 014 only adds.
- No RPC signature changes except the single-function
  `refresh_materialized_views()` body rewrite (same signature, same
  grants, same callers).

---

## 6) Analytics and triage quality model

### 6.0 Glossary — what the UI calls vs. what the code calls

Three distinct concepts in this system all historically got called
"category", which has caused enough confusion that we now use distinct
UI nouns for each. The code identifiers are **deliberately unchanged** ���
renaming columns, enum fields, and props would cascade through the DB,
the OpenAI strict schema, the materialized views, and every API
consumer for no functional gain. The mapping below is the contract; new
code should respect both columns.

| Concept                       | Code identifier                                                  | Storage                                                  | UI label (user-facing)                              | Source                                                                |
|-------------------------------|------------------------------------------------------------------|----------------------------------------------------------|-----------------------------------------------------|-----------------------------------------------------------------------|
| Heuristic top-level bucket    | `category` / `categorySlug` / `category_id`                      | `categories` table; `observations.category_id`            | **"Topic"**                                         | Regex scorer (`lib/scrapers/shared.ts:categorizeIssue`)               |
| LLM strict-schema enum (12)   | `llm_category` (MV); `category` on `classifications` rows        | `classifications.category`                                | **"LLM category"**                                  | OpenAI classifier (`lib/classification/pipeline.ts` + `prompt.ts` + `schema.ts`) |
| LLM free-text per-issue tag   | `llm_subcategory` (MV); `subcategory` on `classifications` rows  | `classifications.subcategory`                             | **"LLM subcategory"**                               | OpenAI classifier (same call, separate field)                         |
| Cluster (semantic family)     | `cluster_id` / `cluster_key`                                     | `clusters` / `cluster_members`                            | **"Family"** (technical contexts: "Semantic cluster, Layer A") | Embedding-based grouping (`lib/storage/semantic-clusters.ts`)         |
| Cluster display name          | `clusters.label` / `label_confidence` / `label_model`            | `clusters.label`                                          | **"Family name"** (defence-in-depth fallback: `Cluster #<short-id>`) | LLM cluster labeller with deterministic Topic+error fallback (`lib/storage/semantic-clusters.ts:labelSemanticCluster` + `lib/storage/cluster-label-fallback.ts:composeDeterministicLabel`) |

Rules for new code:

1. **User-visible strings** (JSX text, button labels, dropdown items, placeholders, badge text, tooltips) — use the UI label column above. Do not write "category" in user-facing copy unless you mean the LLM enum.
2. **Code identifiers** (variables, props, types, function names, DB columns) — keep the legacy names. The disjointness is documented; renaming costs more than it saves and would invalidate the OpenAI strict-schema contract.
3. **Comments at confusion-prone call sites** — `categorizeIssue` (lib/scrapers/shared.ts), `CATEGORY_ENUM` (lib/classification/taxonomy.ts), `labelSemanticCluster` (lib/storage/semantic-clusters.ts), the issues-table LLM-subcategory dropdown, the Hero classification cloud — link back to this glossary (`§6.0`).
4. **Methodology surfaces** (the LayerExplainerRow in classification-triage with `title="Semantic cluster"`, the methodology dialogs) keep the technical noun "Semantic cluster (Layer A)" — that's reviewer-facing language and changing it would be misleading.
5. **Topic filter slug matching** — the Global Filter Bar uses `categories.slug` from the database (e.g., `"ux-ui"`) to filter `realtimeInsights` by `category.slug`. Do NOT generate slugs from `category.name` via string manipulation (e.g., `name.toLowerCase().replace(/\s+/g, "-")`) — this produces mismatches for names with special characters like "UX/UI" (`"ux/ui"` vs database `"ux-ui"`). The `/api/stats` endpoint returns `categoryBreakdown[*].slug` for this purpose.

Decisions and rationale for the names:

- **"Topic"** for the heuristic bucket: the values (Bug, Feature Request, Performance, …) read as topical groupings of feedback, and the word is short and unambiguous in dashboard copy. The legacy `categories` table name is kept because RLS policies, FKs, and stats payload contracts all key off it.
- **"LLM category"** (singular) for the enum: matches the field name `category` in `classifications` and in the OpenAI strict schema. Pluralised in dropdowns ("All LLM Subcategories" — no "All LLM Categories" to avoid ambiguity with the dropdown that actually reads `llm_subcategory`).
- **"LLM subcategory"** for the free-text field: also matches the column name `classifications.subcategory`. The dropdown in the issues table previously read "All LLM Categories" while filtering on `llm_subcategory`; that was renamed in the same pass that introduced this glossary.
- **"Family"** for the semantic cluster as a user-facing concept: the dashboard already had a "Top Families" section before this glossary; the term spreads to active-drill-down chips for consistency. Layer-A methodology language stays "Semantic cluster" so reviewer documentation remains literal.
- **"Family name"** for the cluster label: ties the labeller-produced string to the user-facing noun and removes the verb-form awkwardness of "label/unlabelled". The labeller pipeline (`semantic_cluster_label` v2) tries the small LLM first, escalates to the large LLM on low confidence, and falls through to a deterministic Topic+error fallback (`lib/storage/cluster-label-fallback.ts`) so every cluster has a displayable label at confidence `>= MIN_DISPLAYABLE_LABEL_CONFIDENCE` (currently `0.4`). The UI show-threshold imports the same constant from `cluster-label-fallback.ts`, so the producer/consumer floor cannot drift; `tests/label-confidence-contract.test.ts` fails the build if any UI file regresses to a hardcoded `0.4` literal. The legacy "Unnamed family" placeholder is replaced by `Cluster #<short-id>` for the rare `label IS NULL` defence-in-depth case. See `docs/CLUSTERING_DESIGN.md` §4.4 for the full source-priority chain.

History: §6.1 ("Heuristic category model") and §6.3 ("LLM triage quality controls") have always treated these as separate concepts in the doc; the drift was at the UI label level. This glossary closes that gap.

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

Current score (`lib/analytics/realtime.ts`) blends four terms:

```
urgencyScore =
    decayedVolume       * 1.6   // linear decay from 1.0 at "now" to 0.0 at window edge
  + max(momentum, 0)    * 1.4   // nowCount - previousCount, floored at 0
  + avgImpact           * 1.0   // mean impact_score in the "now" bucket
  + (sourceDiversity-1) * 0.8   // distinct-source bonus, 0 for single-source
```

Notes on what is *not* a separate term:

- **Negative sentiment ratio is not weighted here.** PR #11 removed the
  former `negativeRatio * 3` term because sentiment is already applied
  upstream in `calculateImpactScore` (1.5× boost for
  `sentiment === "negative"`) and was being double-counted. `negativeRatio`
  is still computed and returned for the dashboard card but is a display
  signal, not a ranking input.
- `keyword_presence` (the count of bug-topic regex hits from
  `NEGATIVE_KEYWORD_PATTERNS`) is returned by `analyzeSentiment` but not
  stored on any row and not consumed here. See `docs/SCORING.md` for the
  full story.

Future improvements:
1. Add cross-source duplicate clustering (same story across HN + Reddit).
2. Per-category dynamic thresholds (some categories are noisy by default).
3. Anomaly detection for sudden surge alerts independent of urgency rank.
4. Decide the fate of `keyword_presence` (remove, persist, or wire in).

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

## 6.5) Data provenance — what is real vs reference

This system intentionally keeps zero synthetic dashboard data. Everything the
running app renders is either a live API response or a Supabase read of rows
that scrapers/classifiers populated from real public sources.

Real data (live, never seeded):
- Evidence-layer rows (`observations`, `observation_revisions`, `engagement_snapshots`, `ingestion_artifacts`) — written by `lib/scrapers/providers/{reddit,hackernews,github,github-discussions,stackoverflow,openai-community}.ts` via `lib/storage/evidence.ts`, each of which calls a real public API:
  - Reddit JSON search (`reddit.com/r/<sub>/search.json`)
  - Hacker News Algolia search (`hn.algolia.com/api/v1/search`)
  - GitHub Issues Search — REST (`api.github.com/search/issues`)
  - GitHub Discussions Search — GraphQL (`api.github.com/graphql`, `search(type: DISCUSSION)`; requires `GITHUB_TOKEN`, degrades to a no-op when absent)
  - Stack Exchange (`api.stackexchange.com/2.3/questions`)
  - OpenAI Community — Discourse (`community.openai.com/search.json`)
- Derivation-layer rows (`sentiment_scores`, `category_assignments`, `impact_scores`, `competitor_mentions`) — written by the enrich pass (`lib/storage/derivations.ts`) against captured evidence. Every row is version-stamped.
- `classifications` and `classification_reviews` rows — written by `app/api/classify/route.ts` and `app/api/classifications/[id]/route.ts` from the OpenAI Responses API and reviewer actions respectively.
- Aggregation-layer rows (`clusters`, `cluster_members`) — written by `lib/storage/clusters.ts`.
- Materialized views (`mv_observation_current`, `mv_trend_daily`) — rebuilt at the end of each cron run from derivation + aggregation rows.
- `scrape_logs` rows — written by `lib/scrapers/index.ts` per run.

Reference data (seeded once via SQL, required for foreign keys to work):
- `sources` rows — one per provider (`reddit`, `hackernews`, `github`,
  `github-discussions`, `stackoverflow`, `openai-community`). See
  `scripts/007_three_layer_split.sql`.
- `categories` rows — taxonomy used by the heuristic classifier (`Bug`,
  `Feature Request`, `Performance`, …). Same migration file.
- `algorithm_versions` — lookup of the current-effective version per derivation type (sentiment, category, impact, competitor-mention, classification). Seeded at v1.

**Not wired into the running app, and now removed from the repo entirely:**
- A previous `codex-analysis/` directory contained pre-computed JSON
  snapshots (`codex_analysis_data*.json`) and a Python loader
  (`backend/load_data_supabase.py`) that wrote synthetic monthly timeline
  rows directly into the `issues` table. None of it was ever imported by
  `app/`, `lib/`, `components/`, or `hooks/`, but its mere presence meant
  the loader could be run against a real Supabase and pollute the
  dashboard with fake data. The entire directory has been deleted so the
  repo no longer ships any placeholder dataset.

How to verify at any time:
```sh
# 1) No placeholder dataset, mock module, or fixture folder exists
test ! -d codex-analysis && \
  ! grep -R --include='*.ts' --include='*.tsx' \
    -E 'fixtures?/|mock(Data|Issues)|SAMPLE_ISSUES' app lib components hooks

# 2) Every dashboard surface flows from /api/* via SWR
grep -R --include='*.ts' --include='*.tsx' 'useSWR' hooks

# 3) Scrapers hit live HTTPS URLs (not local files)
grep -R --include='*.ts' -n 'https://' lib/scrapers/providers

# 4) SQL migrations only seed reference taxonomy, never evidence rows
grep -nE 'INSERT INTO (observations|observation_revisions|engagement_snapshots|ingestion_artifacts)' scripts/*.sql   # should print nothing

# 5) Evidence layer is append-only — no code path outside lib/storage/evidence.ts
#    may issue UPDATE/DELETE against evidence tables
grep -REn '\.from\("(observations|observation_revisions|engagement_snapshots|ingestion_artifacts)"\)\.(update|delete)' lib app
# expected: zero matches
```
All five should return only the expected runtime call sites — no fixture imports, no seeded evidence rows, no mutations of the evidence layer from outside `lib/storage/evidence.ts`.

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
1. Monitor `% classifications with a non-null observation_id`.
2. Validate mapping from ingest `observations` rows into classify requests.
3. Backfill `observation_id` on legacy classification rows by matching `source_issue_url` → `observations.url`.
4. Block "authoritative" reviewer status transitions without a linked observation in strict mode.

### 7.3 Core health metrics

- scrape success rate by source,
- ingestion precision (sampled relevance),
- realtime insight precision (sampled relevance),
- classifier confidence distribution,
- reviewer override rate by category/severity,
- median time from `new` → `triaged`,
- traceability coverage (`classifications.observation_id` present),
- % reviewed rows with reviewer notes.

### 7.4 Replaying a past dashboard reading

The evidence-is-immutable + derivation-is-versioned invariants make any past dashboard number reproducible from the database alone. To reconstruct what the dashboard showed on date `T`:

1. Pin the cutoff: `SET LOCAL app.as_of = '<T>';` (or pass `as_of=T` to the API route that supports it).
2. Restrict every derivation read to rows with `computed_at <= T`, picking the max `algorithm_version` that has a row at or before `T`. A `latest_as_of(T)` SQL helper handles the row-number window.
3. Restrict cluster membership to rows with `attached_at <= T AND (detached_at IS NULL OR detached_at > T)`.
4. Restrict engagement snapshots to the latest row per observation with `captured_at <= T`.
5. Rebuild `mv_observation_current` / `mv_trend_daily` against those time-bounded views (one-shot materialization into a scratch schema; the production MVs are not disturbed).
6. Compare the scratch-schema aggregates to any captured dashboard screenshot or exported KPI — they must match byte-for-byte if nothing upstream was deleted (and upstream deletions don't apply, per the append-only evidence policy).

This is the primary justification for the three-layer split: scoring-algorithm drift (N-6), lexicon updates, competitor-phrase expansions, and reviewer revisions can all happen freely because the derivation layer preserves the full history.

---

## 8) Near-term roadmap (data-analyst lens)

### Short-term (1–2 sprints)

- Add queue pagination and stage-based filters (`new`, `triaged`, `in-progress`, etc.).
- Build reviewer override deltas table for model-eval corpora.
- Add explicit dashboard card for traceability coverage trend over time.
- Add contract tests for `/api/classify` and `/api/classifications/*`.

### Medium-term (1–2 months)

- Introduce agreement metrics between heuristic category and LLM category.
- Add anomaly alerts for sudden spikes in critical/`autonomy_safety_violation` classifications.
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
5. **Actionability over vanity metrics**: optimize for triage decisions, not chart volume; prioritize category risk narratives over raw counts. Any "top issue" claim must include sentiment composition (negative/neutral/positive mix) and at least one representative issue title/link for evidence. Interpret dashboard priority copy with the [Dashboard interpretation contract](./SCORING.md#8-dashboard-interpretation-contract).
6. **Comparative context over absolute volume**: rising category risk and worsening negative-share trend are stronger action signals than high total issue count alone.
7. **Raw evidence is append-only**: scrapers insert into the evidence layer and never UPDATE it. Every derived signal (sentiment, category, impact, competitor mention, LLM classification) is a versioned row stamped with `algorithm_version` in the derivation layer. Aggregations (clusters, dashboard materialized views) layer on top and are rebuilt, never mutated in place. This is what makes past dashboard readings reproducible.

### Dashboard UX doctrine

- One orientation metric is allowed: **total reports**.
- Every other headline widget must answer: **what should we fix next, and why**.

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
      github-discussions.ts
      stackoverflow.ts
      openai-community.ts
  storage/                    # three-layer write boundary
    evidence.ts               # recordObservation, recordRevision, recordEngagementSnapshot, recordIngestionArtifact
    derivations.ts            # recordSentiment, recordCategory, recordImpact, recordCompetitorMention, recordClassification, recordClassificationReview
    clusters.ts               # attachToCluster, detachFromCluster, promoteCanonical + cluster_key normalization
    algorithm-versions.ts     # central registry of current-effective versions per derivation type

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

---

## 11) Migration runbook — applying the three-layer split

The three-layer split ships as three SQL migrations that must be applied in order. Migrations 001–006 are preserved in git history; they are NOT part of the forward path for a fresh install.

### 11.1 Scope and prerequisites

`scripts/007_three_layer_split.sql` is a **destructive cutover** migration: it drops the old `issues` and `bug_report_classifications` tables and recreates the schema in the three-layer shape. This migration assumes the operator has accepted a full repull from all six providers and does not need to preserve historical rows.

If you need row-for-row preservation of `issues` data, DO NOT apply 007 as-is. Instead, stop and implement a two-step alternative:
1. A non-destructive `007a` that adds new tables alongside existing ones.
2. A `007b` backfill that walks `issues` → `observations` + version-v1 derivation rows.
3. A `007c` cutover that swaps reads to the new tables.
4. `008_drop_legacy_tables.sql` gated on row-count parity.

This runbook covers the destructive path, which is what the current branch implements.

### 11.2 Apply order (destructive-cutover path)

```
# 1. Take a full pg_dump before running anything destructive.
pg_dump --no-owner --format=custom "$DATABASE_URL" > backup-pre-007.dump

# 2. Run 007 (drops legacy tables + creates new schema + seeds reference data).
psql "$DATABASE_URL" -f scripts/007_three_layer_split.sql

# 3. Run 008 (revokes service_role DML on append-only tables).
psql "$DATABASE_URL" -f scripts/008_revoke_service_role_dml.sql

# 4. Run 009 (as_of replay function) and 010 (perf indexes on the MV).
psql "$DATABASE_URL" -f scripts/009_as_of_functions.sql
psql "$DATABASE_URL" -f scripts/010_perf_indexes.sql

# 5. Deploy the app code from commit 87ecf95 or later (app reads
#    mv_observation_current / mv_trend_daily).

# 6. Trigger a full repull.
curl -X POST "$APP_URL/api/scrape" \
  -H "Authorization: Bearer $CRON_SECRET"

# 7. Verify the materialized views refreshed at the end of the scrape run
#    and mv_observation_current is populated.
```

### 11.3 Post-apply validation queries

Run these against the production database after 007 + 008 + first scrape. All should return expected counts > 0 for an active system.

```sql
-- Evidence layer populated
select count(*) from observations;
select count(*) from engagement_snapshots;

-- Derivation layer populated
select count(*) from sentiment_scores;
select count(*) from category_assignments;
select count(*) from impact_scores;

-- Aggregation layer populated
select count(*) from clusters;
select count(*) from cluster_members where detached_at is null;

-- Materialized views rebuilt
select count(*) from mv_observation_current where is_canonical;
select count(*) from mv_trend_daily;

-- Last scrape succeeded
select status, issues_found, issues_added, completed_at
from scrape_logs
order by started_at desc
limit 6;
```

### 11.4 Append-only invariant verification

After 008, prove the privilege layer is actually enforcing RPC-only writes. Connect as `service_role` and attempt direct DML:

```sql
-- Should fail with: permission denied for table observations
insert into observations(source_id, external_id, title) values (gen_random_uuid(), 'tamper', 'x');

-- Should fail with: permission denied for table classifications
update classifications set summary = 'tampered' where id = (select id from classifications limit 1);
```

Any success on the above indicates the REVOKEs in 008 did not land and the evidence layer is writable outside the RPCs — **stop deploys and investigate** before proceeding.

### 11.5 Rollback strategy

The 007 migration is destructive and cannot be cleanly rolled back without data loss. The only supported rollback path is:

1. Stop the app.
2. `psql "$DATABASE_URL" -c 'drop schema public cascade; create schema public;'`
3. `pg_restore --clean --no-owner -d "$DATABASE_URL" backup-pre-007.dump`
4. Redeploy the pre-007 app code (any commit before `7587e2f`).

Because 007 drops `issues` and `bug_report_classifications` and the new schema is not byte-compatible, there is no in-place downgrade. Practice the restore on a staging database before running 007 in production.

### 11.6 Incremental migrations after 008

Subsequent schema changes should follow the append-only discipline by default:
- New derivation types → new table + new `record_*` RPC + new REVOKE on service_role DML + GRANT EXECUTE on the RPC.
- New aggregation views → prefer materialized views refreshed via `refresh_materialized_views()`.
- Algorithm-version bumps → insert rows in `algorithm_versions` with `current_effective = true`; the partial unique index enforces one effective per kind.

The guiding principle: every write path must either (a) flow through a `SECURITY DEFINER` RPC that the service_role has `EXECUTE` on, or (b) target a table where service_role retains direct DML (reference tables and aggregation tables). Never both for the same table.

### 11.7 Admin operator surface (`/admin`)

Algorithm-version bumps need an operator path that does not wait for the scrape cron. The scrape providers only re-capture observations in their current fetch window (~150–500 rows), so the cron's enrich pass only writes new-version rows for those observations — the long tail keeps the old version as its latest derivation forever. Because `mv_observation_current` picks newest-by-`computed_at` regardless of algorithm_version (§5.3), any mixed-version population silently corrupts downstream charts: the 30-day trend compares this-week's new-version scores against last-month's old-version scores as if they were the same metric.

`/admin` (implemented by `app/admin/page.tsx` + `app/api/admin/backfill-derivations/route.ts` + `app/api/admin/cluster/route.ts`) closes this gap. The backfill endpoint walks `observations` in keyset-paginated chunks and writes current-version rows via the same `record_*` RPCs the enrich pass uses, so all derivation-layer invariants from §3.1b and §5.2 are preserved — the admin surface has no privileged write path of its own. Per-kind pre-checks make the pass idempotent at the application layer and resumable at chunk granularity. On the final chunk the route calls `refresh_materialized_views()` so the dashboard immediately reflects the new state; without this step the backfill silently stalls until the next cron tick.

Auth is a single shared `ADMIN_SECRET` checked against an `x-admin-secret` request header. In production the secret is required — a missing env var fails closed with 503 rather than silently opening the endpoints (the admin surface is write-heavy and can trigger full-DB cluster rebuilds). In non-production environments the secret is optional.

A second panel on `/admin` manages clustering: live stats (observations, clusters, active memberships, orphans, top-N by frequency) pulled from `mv_observation_current where is_canonical`, plus a chunked `attach_to_cluster` rebuild. Attach-only is idempotent via the partial unique index (§3.1c); re-detach mode exists for the rare case where the `buildClusterKey` function itself changes.


## 12) Error tracking and runtime observability

The app now includes a lightweight, first-party error tracking layer aimed at fast debugging in Vercel Runtime Logs with minimal operational overhead.

### 12.1 Design goals

1. **Catch client failures early** (uncaught errors + unhandled promise rejections).
2. **Keep logging non-blocking** (logging must never break user flow).
3. **Separate client and server concerns** (browser reports via API; server logs directly).
4. **Prefer structured payloads** so logs are grep/search friendly in Vercel.

### 12.2 Runtime flow

```text
Client runtime (browser)
  ├─ component/runtime error occurs
  ├─ GlobalErrorHandler catches error / promise rejection
  ├─ logClientError(...) builds safe payload
  └─ POST /api/log-client-error
          │
          ▼
Server runtime (Next.js route)
  ├─ app/api/log-client-error/route.ts validates/coerces payload
  ├─ console.error(...) emits structured event
  └─ Vercel Runtime Logs receives searchable server-side record
```

### 12.3 Modules and responsibilities

- `lib/error-tracking/client-logger.ts`
  - `logClientError`, `logReactError`, `logLocalStorageError`, `logAndroidWebViewError`.
  - Guards browser-only APIs (`window`, `localStorage`) and swallows transport failures.
- `components/global-error-handler.tsx`
  - Registers global listeners for `error` and `unhandledrejection`.
  - Forwards normalized events through `logClientError`.
- `app/api/log-client-error/route.ts`
  - Normalizes unknown payloads to safe strings/objects.
  - Emits server log lines via `console.error` for Vercel ingestion.
- `lib/error-tracking/server-logger.ts`
  - `logServer`, `logServerError`, plus `logMathCoach` helper for specialized server event streams.

### 12.4 Operational guidance

- **When in browser/client code:** use `logClientError` helpers.
- **When in API/middleware/server code:** use `logServer` or `logServerError` directly (no API round-trip needed).
- **When adding new logging calls:** include stable `component` and `event` names so query filters stay consistent over time.

### 12.5 Known limitations

- This is log-forwarding only (no persistent error warehouse yet).
- No deduplication/grouping policy is applied in-process.
- Alerting/integrations (Sentry, Datadog, etc.) are intentionally out of scope for the current simple implementation.
