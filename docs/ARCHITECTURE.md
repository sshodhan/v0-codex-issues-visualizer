# Codex Issues Visualizer — Architecture Guide

_Last updated: 2026-04-21 (v10 — three-layer data model: evidence (append-only) + derivation (versioned, immutable) + aggregation (clusters + materialized views). Full schema rewrite: `issues` and `bug_report_classifications` tables removed in favor of `observations`/`observation_revisions`/`engagement_snapshots`/`ingestion_artifacts` + `sentiment_scores`/`category_assignments`/`impact_scores`/`competitor_mentions`/`classifications`/`classification_reviews` + `clusters`/`cluster_members`. Past dashboard readings are reproducible via derivation `computed_at <= T` filters. See `scripts/007_three_layer_split.sql` and `lib/storage/`. Supersedes PR #12 clustering edge cases (P1-9 through P1-12). v9 — issue-clustering / canonical-frequency data model documented, edge cases captured (PR #12); v8 — integrates with PR #11 urgency rework (sentiment weight in impact, not urgency) + `keyword_presence` signal; fallback-sentiment backchannel removed, full lexicon unification closes P0-2, window char-cap for unpunctuated blobs, summarizeCompetitiveMentions extracted, regex cache, re-export shim dropped; v7 — backward-compatible nullable sentiment, parameterized anchor brand, canonical competitor/lexicon modules, weighted meta, false-positive regression tests; v6 — mention-level competitive sentiment + transparency metrics; v5 — GitHub Discussions + OpenAI Community sources added; v4 — Stack Overflow source, competitive insights, data provenance section)_

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
  │   └─ materialized views       (mv_observation_current, mv_dashboard_stats, mv_trend_daily)
  │                                (refreshed on cron end via refresh_materialized_views())
  │
  └─ Reference tables (unchanged)
      ├─ sources, categories
      └─ scrape_logs
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
  ├─ KPI cards + trend/source/sentiment/category visuals
  ├─ realtime urgency insights (now with source diversity)
  ├─ competitive mentions panel
  ├─ issues table (source links)
  └─ classification triage panel (traceability + reviewer workflow)
```

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
6. Rescoring the entire corpus against a new algorithm is a normal insert job (insert derivation rows at version N+1); the old rows stay for reproducibility.

#### 3.1c Cluster (writes to aggregation layer only)

1. For each observation in this run, compute `cluster_key` from the normalized title via `lib/storage/clusters.ts` → `attachToCluster()`.
2. If no cluster exists for that key, insert one into `clusters` (with this observation as `canonical_observation_id`) and add the membership row.
3. If a cluster exists, append a `cluster_members` row (`attached_at = now()`, `detached_at = NULL`).
4. On a title revision that shifts `cluster_key`, the same function updates the membership: stamp `detached_at` on the old row, insert a new one for the new cluster, and re-select a canonical if needed. Because clusters are their own table, rebalancing never touches evidence.
5. At the end of the scrape run, `/api/cron/scrape` calls the `refresh_materialized_views` RPC, which rebuilds `mv_observation_current`, `mv_dashboard_stats`, and `mv_trend_daily`. All dashboard reads pick up the new scrape after this step.

#### 3.1.1 Clustering invariants

- **Clusters are stored separately from evidence.** Deleting or revising an observation never mutates cluster shape; the orchestrator explicitly detaches/reattaches via `cluster_members`.
- **Exactly one active canonical per cluster.** Enforced by `UNIQUE INDEX ON clusters(cluster_key)` plus a `canonical_observation_id` NOT NULL constraint. Canonical selection is a cluster property, not a flag on an observation.
- **Cluster membership is append-only per attach/detach event.** `detached_at IS NULL` is the active set; history is preserved.
- **`cluster_key` normalization lives in TypeScript only.** Since SQL never writes to `clusters`/`cluster_members` directly (only via the storage module), the former TS-vs-SQL hash parity requirement is obsolete.

### 3.2 LLM classification flow

1. Client/backend posts report payload to `/api/classify`.
2. Server builds bounded context (`report_text`, env, repro, transcript/tool/log tails).
3. OpenAI Responses API is called with strict JSON-schema response format (`temperature: 0.2`).
4. If `confidence < 0.7`, route retries once on the larger model. Each retry inserts its own row into `classifications` with `prior_classification_id` pointing at the previous attempt — every LLM call is preserved as evidence of classifier drift and retry behavior.
5. Boundary validation runs:
   - enum validation,
   - `evidence_quotes` substring validation against request payload,
   - hard review rules (critical/safety/low confidence/sensitive mentions).
6. Output is returned and stored in `classifications` as normalized fields + raw JSON via `lib/storage/derivations.ts` → `recordClassification()`. Rows in `classifications` are immutable after insert.

### 3.3 Reviewer flow

1. Dashboard fetches queue rows from `GET /api/classifications`. The endpoint returns the classification baseline joined to the most recent matching `classification_reviews` row so the queue shows effective state (post-review).
2. Dashboard fetches queue KPIs from `GET /api/classifications/stats` aggregated over the same join.
3. Reviewer selects a row, checks source-link traceability, and updates status/category/severity/notes.
4. Dashboard sends patch to `PATCH /api/classifications/:id`.
5. The endpoint **inserts** a new row into `classification_reviews` (via `recordClassificationReview()`) — it never UPDATEs the classification. The LLM baseline stays immutable; every reviewer decision appends, preserving the full audit trail. A reviewer who changes their mind produces a second review row; the first is retained.

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

### 3.4 Insight traceability flow

For any dashboard number, the analyst can walk the chain backwards:

1. **Dashboard widget** → the materialized view row it was sourced from (`mv_dashboard_stats`, `mv_trend_daily`, `mv_observation_current`).
2. **Materialized view** → the derivation rows it aggregates, each stamped with `algorithm_version` and `computed_at`.
3. **Derivation row** → the `observations` row it was computed against, plus (for classifications) the `classification_reviews` that modified effective state.
4. **Observation** → the full capture chain: the first-sighting row, any `observation_revisions` entries (OP edits), `engagement_snapshots` over time, and the raw upstream payload in `ingestion_artifacts`.
5. **Upstream evidence** → the `url` field on the observation links back to the original Reddit / HN / GitHub / Stack Overflow / OpenAI Community post.

Past readings are reproducible: re-running any aggregate with `computed_at <= T` over the derivation layer yields exactly the numbers the dashboard showed at time T, regardless of later algorithm changes or reviewer overrides.

---

## 4) Module map and responsibilities

### 4.1 `lib/scrapers/`

Layout:
- `lib/scrapers/index.ts` — orchestrator. `runAllScrapers()` (parallel) and
  `runScraper(slug)` (single-source). Owns `scrape_logs` lifecycle and runs the
  three-pass ingest/enrich/cluster flow, delegating every write to
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
- `lib/scrapers/providers/{reddit,hackernews,github,github-discussions,stackoverflow,openai-community}.ts` —
  one provider per file. Each owns its source-specific query and mapping into
  a `CapturedRecord` shape (evidence-layer fields only). `github-discussions`
  and `openai-community` cover the high-signal channels that the REST `github`
  scraper and the news/Q&A providers miss.

### 4.7 `lib/storage/`

The only module allowed to write to the database. Enforces the three-layer boundary at the module level; complements the DB-level RLS grants described in §5.6.

- `evidence.ts` — `recordObservation(record)`, `recordRevision(observationId, changes)`, `recordEngagementSnapshot(observationId, upvotes, comments)`, `recordIngestionArtifact(key, payload)`. All calls go through `SECURITY DEFINER` RPCs; no direct table writes.
- `derivations.ts` — `recordSentiment(observationId, result)`, `recordCategory`, `recordImpact`, `recordCompetitorMention`, `recordClassification(payload, priorId?)`, `recordClassificationReview(classificationId, review)`. Each pulls the current `algorithm_version` from `algorithm-versions.ts` and stamps the row.
- `clusters.ts` — `attachToCluster(observationId, title)`, `detachFromCluster(observationId)`, `promoteCanonical(clusterId)`. Owns `buildClusterKey` + `normalizeTitleForCluster` (migrated from `lib/scrapers/shared.ts`). Since SQL no longer writes to clusters, the old TS↔SQL hash-parity requirement is obsolete.
- `algorithm-versions.ts` — central `CURRENT_VERSIONS = { sentiment: "v1", category: "v1", impact: "v1", competitor_mention: "v1", classification: "v1" }`. Bumping here is the only way to trigger a new derivation row shape.

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
- `category_assignments (observation_id, algorithm_version, category_id, confidence NUMERIC(3,2), computed_at)`.
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

### 5.3 Aggregation layer

The only layer consumed by the dashboard API routes. Every row can be rebuilt from derivation + evidence.

- `clusters (id UUID PK, cluster_key TEXT NOT NULL UNIQUE, canonical_observation_id UUID NOT NULL, status TEXT, created_at TIMESTAMPTZ)`.
- `cluster_members (cluster_id, observation_id, attached_at, detached_at)` with a partial unique index `(cluster_id, observation_id) WHERE detached_at IS NULL` so an observation can belong to at most one active cluster.
- Materialized views (refreshed by `refresh_materialized_views()` at `/api/cron/scrape` run end):
  - `mv_observation_current` — one row per active cluster-canonical observation joined to the latest derivation rows and the latest engagement snapshot. Backs `/api/issues` and the Priority Matrix.
  - `mv_dashboard_stats` — pre-aggregated totals for `/api/stats` (sentiment breakdown, source breakdown, category breakdown, total). Replaces the six sequential full-table scans.
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
- Materialized views (`mv_observation_current`, `mv_dashboard_stats`, `mv_trend_daily`) — rebuilt at the end of each cron run from derivation + aggregation rows.
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
5. Rebuild `mv_observation_current` / `mv_dashboard_stats` / `mv_trend_daily` against those time-bounded views (one-shot materialization into a scratch schema; the production MVs are not disturbed).
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
