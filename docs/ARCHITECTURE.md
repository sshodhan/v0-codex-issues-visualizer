# Codex Issues Visualizer — Architecture Guide

_Last updated: 2026-04-21 (v9 — issue-clustering / canonical-frequency data model documented, edge cases captured (PR #12); v8 — integrates with PR #11 urgency rework (sentiment weight in impact, not urgency) + `keyword_presence` signal; fallback-sentiment backchannel removed, full lexicon unification closes P0-2, window char-cap for unpunctuated blobs, summarizeCompetitiveMentions extracted, regex cache, re-export shim dropped; v7 — backward-compatible nullable sentiment, parameterized anchor brand, canonical competitor/lexicon modules, weighted meta, false-positive regression tests; v6 — mention-level competitive sentiment + transparency metrics; v5 — GitHub Discussions + OpenAI Community sources added; v4 — Stack Overflow source, competitive insights, data provenance section)_

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

1. A scrape is triggered manually (`/api/scrape`) or by cron route.
2. Source adapters fetch raw records.
3. Candidates are cleaned and filtered (normalize whitespace, relevance, low-value exclusions).
4. Remaining records are enriched with sentiment, heuristic category, and impact score.
5. Records are deduped and passed to `persistIssueWithClustering` (`lib/scrapers/index.ts`), which derives a deterministic `cluster_key` from the normalized title and either (a) updates the existing `(source_id, external_id)` row, (b) links the new row to an existing canonical and increments the canonical's `frequency_count`, or (c) inserts a new canonical row for a fresh cluster. Raw-report traceability is preserved via `canonical_issue_id`.
6. Run metadata is written to `scrape_logs`.

#### 3.1.1 Clustering invariants (target state)

- **Exactly one canonical per `cluster_key`.** Enforced today only by in-process read-then-write; should be tightened to a partial unique index (`CREATE UNIQUE INDEX … ON issues(cluster_key) WHERE is_canonical = true`) with the persist path wrapped in a Postgres function or atomic `INSERT … ON CONFLICT` so concurrent scrapers cannot create rival canonicals.
- **Non-canonical rows point to their canonical** (`canonical_issue_id`) and keep their own raw content for traceability.
- **`frequency_count` lives only on the canonical row**; members stay at 1. Incrementing should be atomic (SQL-side `frequency_count = frequency_count + 1`), not a JS read-modify-write.
- **`cluster_key` normalization must be identical in TS and SQL.** The TS path (`buildIssueClusterKey` in `lib/scrapers/shared.ts`) and any backfill SQL must use the same algorithm and hash or the backfill will not merge with scraped rows. Today they diverge (see `docs/BUGS.md`); both must settle on one hash (MD5 matches Postgres' built-in) and identical regex semantics under `standard_conforming_strings = on`.

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
  `runScraper(slug)` (single-source). Owns scrape_logs lifecycle and writes
  rows via `persistIssueWithClustering`, which derives a `cluster_key` per
  issue and manages canonical/non-canonical linkage + `frequency_count`.
- `lib/scrapers/shared.ts` — relevance filter (delegates to `relevance.ts`),
  ingest-time sentiment classifier (`analyzeSentiment`, consumes the
  canonical lexicon in `lib/analytics/sentiment-lexicon.ts`), topic-noun
  presence counter (`calculateKeywordPresence`, drawn from
  `NEGATIVE_KEYWORD_PATTERNS`), category scoring, impact scoring,
  competitor keyword detection, retry/backoff fetch helper, dedupe, and the
  deterministic `buildIssueClusterKey` + `normalizeTitleForCluster` helpers
  that drive clustering. The SQL counterpart in
  `scripts/005_add_issue_clustering_and_frequency_backfill.sql` must be kept
  byte-for-byte equivalent (same normalization, same hash algorithm). **Does
  not own polarity word lists or competitor phrases** — those are imported
  from the analytics-layer canonical modules. `analyzeSentiment` returns
  `{ sentiment, score, keyword_presence }`; providers today destructure only
  the first two. See `docs/SCORING.md` for the current signal contract.
- `lib/scrapers/providers/{reddit,hackernews,github,github-discussions,stackoverflow,openai-community}.ts` —
  one provider per file. Each owns its source-specific query and the
  mapping into a `Partial<Issue>`. `github-discussions` and `openai-community`
  cover the high-signal channels (GitHub Discussions, community.openai.com)
  that the REST `github` scraper and the news/Q&A providers miss.

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

### 5.1 Existing operational tables

- `sources`: source registry.
- `categories`: canonical heuristic categories.
- `issues`: normalized issue facts from public sources, now with clustering
  metadata:
  - `cluster_key TEXT` — deterministic title-based grouping key
    (`title:<16-char hash>`). **Should be `NOT NULL`** with a default of
    `'title:empty'`; today nullable.
  - `canonical_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL` —
    non-canonical rows point to their cluster's canonical. `ON DELETE SET
    NULL` leaves members orphaned when a canonical is deleted; a trigger
    should promote the oldest remaining member instead.
  - `is_canonical BOOLEAN DEFAULT TRUE` — marks the representative row for
    a cluster. Default is `TRUE` for ergonomic inserts; the persist path
    writes the flag explicitly.
  - `frequency_count INTEGER DEFAULT 1` — aggregated report count, kept on
    the canonical row only. Increments should be atomic (SQL-side) and, for
    repeat observations of already-known external posts, should bump the
    canonical's count past the first-sighting insert.
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
- Clustering lookup indexes: `idx_issues_cluster_key` on `cluster_key`,
  `idx_issues_canonical` on `is_canonical`.
- **Target (not yet in place):** partial unique index
  `ON issues(cluster_key) WHERE is_canonical = true` to prevent concurrent
  scrapers from inserting rival canonicals for the same cluster.
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
- `issues` rows — written by `lib/scrapers/providers/{reddit,hackernews,github,github-discussions,stackoverflow,openai-community}.ts`,
  each of which calls a real public API:
  - Reddit JSON search (`reddit.com/r/<sub>/search.json`)
  - Hacker News Algolia search (`hn.algolia.com/api/v1/search`)
  - GitHub Issues Search — REST (`api.github.com/search/issues`)
  - GitHub Discussions Search — GraphQL (`api.github.com/graphql`, `search(type: DISCUSSION)`; requires `GITHUB_TOKEN`, degrades to a no-op when absent)
  - Stack Exchange (`api.stackexchange.com/2.3/questions`)
  - OpenAI Community — Discourse (`community.openai.com/search.json`)
- `scrape_logs` rows — written by `lib/scrapers/index.ts` per run.
- `bug_report_classifications` rows — written by `app/api/classify/route.ts`
  from the OpenAI Responses API.

Reference data (seeded once via SQL, required for foreign keys to work):
- `sources` rows — one per provider (`reddit`, `hackernews`, `github`,
  `github-discussions`, `stackoverflow`, `openai-community`). See
  `scripts/001_*.sql`, `002_*.sql`, `003_*.sql`, `005_*.sql`.
- `categories` rows — taxonomy used by the heuristic classifier (`Bug`,
  `Feature Request`, `Performance`, …). Same migration files.

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

# 4) SQL migrations only seed reference taxonomy, never issues
grep -nE 'INSERT INTO issues' scripts/*.sql   # should print nothing
```
All four should return only the expected runtime call sites — no fixture
imports, no seeded `issues` rows, no `file://` URLs.

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
5. **Actionability over vanity metrics**: optimize for triage decisions, not chart volume; interpret dashboard priority copy with the [Dashboard interpretation contract](./SCORING.md#8-dashboard-interpretation-contract).
6. **Actionability over vanity metrics**: prioritize category risk narratives over raw counts; any "top issue" claim must include sentiment composition (negative/neutral/positive mix), and surfaced priorities must include at least one representative issue title/link for evidence.
7. **Comparative context over absolute volume**: rising category risk and worsening negative-share trend are stronger action signals than high total issue count alone.

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
