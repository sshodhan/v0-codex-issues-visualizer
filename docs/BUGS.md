# Bug & Issues Backlog

_Generated: 2026-04-20 from two independent senior-engineer end-to-end reviews._
_Last reviewed: 2026-04-20 on branch `claude/review-pr-11-SPlkP` (after PR #11 + stacked improvements)._
_Updated: 2026-04-21 on branch `claude/review-edge-cases-sCBSO` — clustering feature (PR #12) edge cases from two independent follow-up reviews._

Each entry includes priority, a one-sentence description, the exact file:line
reference, and a minimal fix sketch. Priorities follow the standard
P0 (data-corrupt / silent wrong answer) → P1 (significant quality loss) →
P2 (polish / UX gap) scale.

Each entry also carries a **Status** line reflecting the state on
`claude/review-pr-11-SPlkP`: _addressed_, _partial_, _still-open_, or
_superseded_. See `docs/SCORING.md` for the canonical description of the
current sentiment / impact / urgency pipeline.

---

## P0 — Data integrity / silent wrong answers

### P0-1: Reddit query matches all Microsoft Copilot products, not just Codex-adjacent ones

**File:** `lib/scrapers/providers/reddit.ts:27`

**Problem:** The bare term `copilot` in the OR query matches posts about
Microsoft 365 Copilot, Windows Copilot, Power Platform Copilot, etc.
`isLikelyCodexIssue()` only re-checks title+selftext after the API returns, so
Reddit already limits the result set to 25 posts per subreddit before the
client-side filter runs. Posts about unrelated Copilot products consume budget
and inflate issue counts.

```ts
// current
'(codex OR copilot OR "openai codex" OR "codex cli")'

// fix — require "github copilot" or "copilot chat" at the query level
'(codex OR "github copilot" OR "copilot chat" OR "openai codex" OR "codex cli")'
```

**Status:** _addressed_ by PR #15 (`1cf07a0` on `main`). Reddit's query is
now built from `REDDIT_SCOPED_QUERY_TERMS` in `lib/scrapers/relevance.ts`,
which only includes scoped Codex phrases (`"openai codex"`, `"chatgpt codex"`,
`"codex cli"`, `"openai/codex"`, `"codex terminal"`) — no bare `codex` or
`copilot`. HN and the other providers were updated in the same PR to share
the central phrase list.

---

### P0-2: Sentiment signal conflates functional words with emotional words — addressed in PR #11 + follow-ups

**Status:** ✅ Fixed on 2026-04-20 as a side effect of the competitive-sentiment
lexicon unification.

**Implemented fix:** `analyzeSentiment` in `lib/scrapers/shared.ts` now
consumes `POSITIVE_WORDS` / `NEGATIVE_WORDS` from the canonical
`lib/analytics/sentiment-lexicon.ts`. Topic nouns `"bug"`, `"error"`,
`"issue"`, `"problem"`, `"fail"` are deliberately absent from that lexicon,
so bug-category posts are no longer pre-loaded with negative sentiment based
on their *subject*.

The scoring path also switched from substring matching (`lowerText.includes`)
to tokenized whole-word matching (`lowerText.match(/[a-z']+/g)`), eliminating
collateral substring hits like `"debugger"` matching `"bug"` or
`"useless"` matching on any word containing those letters.

**Regression locked in** by `lib/scrapers/shared.test.ts`:
- Topic-noun-only content ("Bug report: error… for this issue and problem.")
  scores as neutral.
- Identifier-like content ("The debugger attached to the process.") is
  immune to substring pollution.
- Real polarity ("great and helpful" / "awful and unusable") still fires.
- Multi-word negatives (`"doesn't work"`, `"not working"`) continue to
  register via regex, independent of the tokenizer.

Note: `calculateImpactScore` still applies a 1.5× multiplier for negative
sentiment (P0-3) — that double-counting problem is separate and unaddressed
by this change. P0-2 addressed the classifier; P0-3 is about how the
classifier's output is consumed downstream.

**Resolution:** PR #11 pulled bug-topic tokens out of `negativeWords` into
`NEGATIVE_KEYWORD_PATTERNS` and exposed the count as `keyword_presence` on
`analyzeSentiment`'s return. Stacked commit `1d91c98` restored
`"unusable"` to `negativeWords`; `"broken"` was intentionally left out
because the `bug` category already weights it (`wholeWord: true`, weight 2
in `CATEGORY_PATTERNS`). Commit `3b6637f` widened
`NEGATIVE_KEYWORD_PATTERNS` to cover tense / plural variants
(`crashes`, `crashed`, `crashing`, `failed`, `failing`, `failures`,
`regressions`, etc.).

**Status:** _partial_. The topic-vs-valence conflation is fixed at the
sentiment layer, but `keyword_presence` is returned from `analyzeSentiment`
and never read by any provider, API route, or UI component — it is dead
data today. See `docs/SCORING.md` §"Known limitations" for the options
(remove, store as a column, wire into urgency). Either resolution closes
this item; holding as _partial_ until a decision lands.

---

### P0-3: Negative-sentiment bias is double-counted in urgency score — addressed in PR #11

**File:** `lib/scrapers/shared.ts:251-256` and `lib/analytics/realtime.ts:119-127`

**Problem:** `calculateImpactScore` already applies a 1.5× multiplier for
negative sentiment, inflating `impact_score` at ingestion time. The urgency
formula then adds `negativeRatio * 3` on top of `avgImpact * 1.0`.
A bug-category issue receives the sentiment penalty twice — once in its stored
`impact_score` and again in the ratio term. This causes bug-category urgency
scores to be materially overstated vs. feature-request or performance issues.

**Fix sketch:** Remove the `sentimentBoost` multiplier from
`calculateImpactScore` (store a pure engagement score) and let the urgency
formula own the full sentiment weighting.

**Resolution:** PR #11 chose the inverse of the fix sketch: it kept the 1.5×
`sentimentBoost` in `calculateImpactScore` (so stored `impact_score` still
reflects sentiment) and removed `negativeRatio * 3` from the urgency formula in
`realtime.ts`. Either path breaks the double-count; this one trades "urgency
owns sentiment" for "impact owns sentiment."

**Status:** _addressed_ (for double-counting). The urgency formula
(`lib/analytics/realtime.ts:119-126`) is now
`decayedVolume*1.6 + max(momentum,0)*1.4 + avgImpact*1.0 + (sources-1)*0.8`
— no sentiment term. Two secondary concerns remain and are tracked
separately in `docs/SCORING.md`:
  1. `impact_score` is now permanently "engagement × sentiment", i.e. the
     pure engagement score is not recoverable from the DB. If a future
     feature wants pure engagement, a new column is required.
  2. The UI copy in `components/dashboard/realtime-insights.tsx:39` still
     advertises "volume + momentum + impact + negative sentiment" as the
     urgency recipe. That string is now out of date; this is a code/UI
     fix, not re-opening the scoring bug.

---

### P0-4: Competitive sentiment is attributed to *all* co-mentioned competitors

**Status:** ✅ Fixed on 2026-04-20, hardened after first senior review, and
re-hardened after the second senior review closed the `fallbackSentiment`
backchannel.

**Implemented fix:** `lib/analytics/competitive.ts` computes sentiment at the
mention level (bounded sentence window around each competitor phrase),
aggregates multiple mentions per competitor per issue, and rolls up
positive/negative/neutral counts with a net-sentiment mean weighted by scored
mentions only. A single issue-level sentiment is never copied to every
co-mentioned competitor — not directly, and not through any fallback.

**Hardening round 1 (v7):**
- API contract preserved: `topIssues[*].sentiment` stays `"positive" |
  "negative" | "neutral" | null`.
- Detection uses `COMPETITOR_KEYWORDS` exclusively; `PRETTY_NAME`-stripping
  is forbidden and regression-tested (Sourcegraph, Gemini cases).
- Strict sentence window (no ±120-char pad).
- Parameterized `anchorBrand` (default `"codex"`) with regex-safe escaping.
- Canonical shared lexicon in `lib/analytics/sentiment-lexicon.ts`.
- Weighted `competitiveMentionsMeta` (by mention volume).
- UI renders coverage/confidence + `totalScoredMentions`.

**Hardening round 2 (v8, this review):**
- **`fallbackSentiment` removed entirely.** The v7 design let zero-evidence
  mentions inherit the ingest-time `issue.sentiment`. A senior reviewer
  identified this as P0-4 reintroduced through a side channel: a post
  dominated by anti-Codex language that merely name-drops Cursor would
  inherit the post-level negative sentiment and attribute it to Cursor
  despite zero Cursor-specific evidence. Removing the fallback means
  evidence-free windows report `sentiment: null` and do NOT increment
  per-competitor `positive`/`negative`/`neutral` counters. Regression locked
  in by `competitive.test.ts`: "P0-4 via fallback channel: negative Codex
  post that name-drops a competitor does NOT attribute negative to the
  competitor".
- **Lexicon unification finished.** `analyzeSentiment` in
  `lib/scrapers/shared.ts` now consumes the canonical lexicon (closes P0-2
  — see separate entry above). The half-unified state (shared module
  created, but shared.ts still had inline lists) that v7 shipped is
  resolved.
- **Window char-cap.** `MAX_WINDOW_CHARS = 280` per side around the
  mention, so an unpunctuated social-media blob no longer collapses the
  window back to full-post scoring. Regression test: "unpunctuated long
  blob is capped at MAX_WINDOW_CHARS per side".
- **`summarizeCompetitiveMentions` extracted.** Meta arithmetic moved out
  of `app/api/stats/route.ts` into `lib/analytics/competitive.ts` so per-
  competitor shape changes and the dashboard aggregation stay in one file.
- **Anchor regex cache.** `getAnchorRegexes` memoizes per-anchor `better`
  / `worse` regexes so the common single-anchor run amortizes to two
  `Map` lookups per window rather than two `new RegExp()` calls.
- **Re-export shim dropped.** `shared.ts` no longer re-exports
  `COMPETITOR_KEYWORDS`; verified no external consumer imports it from
  there. Canonical source is `lib/analytics/competitors.ts`.

**Transparency:** `competitiveMentions[*]` surfaces `rawMentions`,
`scoredMentions`, `coverage`, and `avgConfidence` per competitor. The
`CompetitiveMentions` card renders the weighted coverage/confidence summary
with tooltip definitions so the metrics are not dead payload.

**Status:** _still-open_. `lib/analytics/competitive.ts:55-92` still loops
`for (const [competitor] of Object.entries(COMPETITOR_KEYWORDS))` and
attributes sentiment to every matched competitor. PR #11 and its stack did
not touch this file. Fix sketch still applies.

---

### P0-5: `frequency_count` is never aggregated — always shows 1 — PARTIALLY ADDRESSED (PR #12)

**File:** `scripts/002_create_issues_schema_v2.sql:46` and
`lib/scrapers/index.ts:65-70`

**Problem:** The column default is 1 and the upsert
`ignoreDuplicates: false` updates every field except `frequency_count`. Nothing
ever increments it. The Priority Matrix X-axis (`components/dashboard/priority-matrix.tsx:35,49`)
uses `frequency_count` as the frequency dimension, so every issue sits at x=1:
the chart renders a vertical column of dots rather than a scatter, providing no
frequency signal.

**Resolution status:** PR #12 introduces title-based clustering, per-cluster
canonical rows, and increments `frequency_count` on the canonical when a
*new* cluster member first appears. The Priority Matrix now reads canonical
rows only, so frequency is no longer pinned to 1.

**Open follow-ups from PR #12** — tracked as separate entries below:
P0-7 (stats double-count), P0-8 (SHA-1 vs MD5 mismatch), P0-9 (SQL backfill
regex mismatch), P0-10 (concurrency races), P1-9 through P1-13 (re-scrape
does not re-increment, title-edit rebalance, canonical deletion, Unicode
collapse, nullable cluster_key).

**Status:** _addressed-in-PR-#12_ (commit `5f4b1ff` on
`codex/implement-duplicate-grouping-and-aggregation`). Priority Matrix reads
canonical rows only and `frequency_count` is now bumped SQL-side via the
`increment_canonical_frequency` RPC on every duplicate observation. Title-edit
rebalance and re-observation bumping of already-known externals remain as
P1-9/P1-10 follow-ups.

---

### P0-7: PR #12 — stats aggregates double-count cluster duplicates; only Priority Matrix is canonical-filtered

**File:** `app/api/stats/route.ts:27-90` and `app/api/issues/route.ts:58-92`

**Problem:** After PR #12, `priorityData` filters `is_canonical = true`
(`app/api/stats/route.ts:100`), but every other aggregate in the same route
(`totalIssues`, `sentimentBreakdown`, `sourceBreakdown`, `categoryBreakdown`,
`trendByDay`, `realtimeInsights`, `competitiveMentions`) still scans the raw
`issues` table. `/api/issues` also omits a canonical filter when `clusterKey`
is absent. A cluster with `frequency_count = 5` therefore contributes **5
rows** to Sentiment/Source/Category/Trend widgets but **1 point** to the
Priority Matrix — the dashboards tell contradictory stories, and the trend
chart will fire spurious "surge" insights whenever one viral complaint is
reposted.

**Fix sketch:** Pick one policy and apply it across all aggregates and the
issues list:

1. Filter every count to `is_canonical = true` so counts equal "distinct
   issues", or
2. Keep all rows but weight by the canonical's `frequency_count` for a
   "true report volume" framing.

**Status:** _addressed-in-PR-#12_ (commit `5f4b1ff`). Option 1 landed:
`app/api/stats/route.ts` adds `.eq("is_canonical", true)` to the totals,
sentiment, source, category, trend, realtime, and competitive queries;
`app/api/issues/route.ts` defaults the table to canonical rows and drops
the filter only when a `clusterKey` drilldown is requested.

---

### P0-8: PR #12 — TS clustering uses SHA-1, SQL backfill uses MD5 — the two paths produce disjoint cluster spaces

**File:** `lib/scrapers/shared.ts:311` and
`scripts/005_add_issue_clustering_and_frequency_backfill.sql:16`

**Problem:** `buildIssueClusterKey` hashes the normalized title with SHA-1
(`createHash("sha1").update(normalized).digest("hex").slice(0, 16)`), while
the backfill SQL hashes with `md5(...)`. Even with identical normalization
output, SHA-1 and MD5 produce completely different 16-character hex
prefixes. Every backfilled row therefore lives in a *different* cluster
than every newly scraped row with the same title — duplicate merging
silently fails forever for any row created before the backfill runs.

**Fix sketch:** Pick one algorithm in both places (MD5 is fine for this
non-security use and matches Postgres' built-in) and re-run the backfill.

**Status:** _addressed-in-PR-#12_ (commit `5f4b1ff`).
`lib/scrapers/shared.ts` now calls `createHash("md5")`, matching the SQL
backfill. Identical titles produce identical `cluster_key`s across the two
paths.

---

### P0-9: PR #12 — SQL backfill regex `'\\s+'` under `standard_conforming_strings` doesn't match whitespace

**File:** `scripts/005_add_issue_clustering_and_frequency_backfill.sql:19,21`

**Problem:** With Postgres' default `standard_conforming_strings = on`,
`'\\s+'` is a literal four-character string starting with a backslash.
The regex engine then reads `\\s` as "escaped backslash followed by s" —
matching a literal `\s` sequence, **not whitespace**. Consequence: the
backfill never collapses whitespace, so a title like `"Codex  hangs"`
(double space) backfills to a *different* normalized form than the TS
path produces at runtime. Combined with P0-8 this guarantees backfilled
and runtime keys never line up.

**Fix sketch:** Use single backslashes (`'[^a-z0-9\s]+'`, `'\s+'`) or an
`E'...'` escape-string with `E'\\s+'`. Add a fixture-driven test that
runs the same titles through both the TS normalizer and the SQL
`regexp_replace` chain and asserts identical keys.

**Status:** _addressed-in-PR-#12_ (commit `5f4b1ff`). Backfill now uses
single-backslash patterns (`'[^a-z0-9\s]+'`, `'\s+'`), so the regex engine
matches the `\s` whitespace class correctly under the default
`standard_conforming_strings`. Fixture-driven test (TS↔SQL key parity)
remains a recommended follow-up.

---

### P0-10: PR #12 — concurrent scrapers can produce two canonicals, lose frequency increments, and silently drop writes

**File:** `lib/scrapers/index.ts:30-99` and
`scripts/002_create_issues_schema_v2.sql:34-79`

**Problem:** `persistIssueWithClustering` is a sequence of separate awaits
(select canonical → insert/update → increment). `runAllScrapers` fans
providers out via `Promise.all`, so three failure modes are real:

1. **Two canonicals for one `cluster_key`.** Two parallel writers both see
   no canonical and both insert with `is_canonical = true`. No partial
   unique index rejects this.
2. **Lost frequency increments.** The increment is a read-then-write
   (`update({ frequency_count: (canonical.frequency_count || 1) + 1 })`).
   Two concurrent members both read `N`, both write `N+1`, losing one.
3. **Silently dropped writes on (source_id, external_id) races.** The
   pre-check replaced the old `.upsert(onConflict: "source_id,external_id")`.
   Two concurrent first-time observations both miss the pre-check and both
   insert; the second trips the unique constraint and `persisted` returns
   `false`, leaving the row unwritten and the drop invisible in logs.

**Fix sketch:** Add a partial unique index
`CREATE UNIQUE INDEX ON issues(cluster_key) WHERE is_canonical = true;`,
move the whole persist-and-cluster flow into a single Postgres RPC/trigger
so the sequence is transactional, and replace the frequency read-modify-
write with a SQL-side increment. Restore the `onConflict` upsert behavior
on (source_id, external_id) for the "update existing row" path.

**Status:** _addressed-in-PR-#12_ (commit `5f4b1ff`). Three tightenings
landed together:
  1. New migration `scripts/006_clustering_invariants_and_rpc.sql` adds a
     partial unique index `idx_issues_unique_canonical_per_cluster` on
     `(cluster_key) WHERE is_canonical = true`, pins `cluster_key NOT
     NULL DEFAULT 'title:empty'`, and defines the
     `increment_canonical_frequency(canonical_id UUID)` RPC. Same
     invariants are baked into `scripts/002_create_issues_schema_v2.sql`
     for fresh installs.
  2. `persistIssueWithClustering` now calls the RPC for every canonical
     bump (atomic SQL-side increment, no read-modify-write drift).
  3. When two writers race on the canonical insert, the loser traps
     Postgres `23505` unique-violation and falls through to the "attach
     as member of the winner" path instead of silently dropping the
     row.

---

### P0-6: `/api/stats` performs 5–6 un-cached full-table scans per request

**File:** `app/api/stats/route.ts:27-138`

**Problem:** Every dashboard load (and every SWR 60-second refresh) fires
at minimum 6 sequential Supabase queries — total-count, sentiment, source join,
category join, trend window, priority matrix, scrape-log — all against the
`issues` table with no `Cache-Control`, no memoisation, and no materialized
view. As row counts grow, p99 latency climbs linearly and Supabase free-tier
compute quotas are exhausted quickly.

**Fix sketch:**

1. Add `Cache-Control: s-maxage=60, stale-while-revalidate=120` to the
   response headers.
2. Merge the sentiment + category + source counts into a single aggregation
   query using `GROUP BY`.
3. Consider a nightly materialized view for the trend sparkline data.

**Status:** _still-open_. `app/api/stats/route.ts` still issues six
independent `from("issues").select(...)` calls per request (total, sentiment,
source join, category join, 30-day trend, priority matrix, 6-day window,
last scrape). No `Cache-Control` headers are set. Fix sketch still applies.

---

## P1 — Significant quality or correctness loss

### P1-1: Error state, empty state, and "no env vars" all render identically

**File:** `app/page.tsx:111`

```tsx
} : !stats || stats.totalIssues === 0 ? (
  // "No Data Yet" — shown for fetch errors AND missing config too
```

**Problem:** A Supabase `NEXT_PUBLIC_SUPABASE_URL` misconfiguration or a
network timeout silently falls through to the "No Data Yet" empty state with a
"Refresh Data" CTA. Users and ops have no way to distinguish a configuration
error from a legitimately empty database.

**Fix sketch:** Expose an `isError` state from `useDashboardStats` (already
returned but unused in `page.tsx`) and render a distinct error banner with the
HTTP status or message.

**Status:** _still-open_. `useDashboardStats` still returns `isError`
(`hooks/use-dashboard-data.ts:100-103`), but `app/page.tsx` destructures
only `{ stats, isLoading, refresh }` (line 37). Fix sketch still applies.

---

### P1-2: KPI cards show all-time totals with no time-window or delta

**File:** `app/page.tsx:142-175`

**Problem:** "Total Issues", "Negative Issues", "Feature Requests", "Bug
Reports" are monotonically increasing lifetime counts. A spike last week looks
identical to baseline. No 7-day delta, no percentage change, no period selector.
The cards provide no actionable signal about whether things are getting better
or worse.

**Fix sketch:** Add `last7dCount` and `prev7dCount` fields to the stats
payload, display a ±N% badge on each card, and add a period toggle (7d / 30d /
all) that filters all four counts.

**Status:** _still-open_. `/api/stats` still returns lifetime
aggregates only; no 7d / 30d delta fields have been added.

---

### P1-3: Category KPI cards use fragile hardcoded display-name string match

**File:** `app/page.tsx:156,166`

```tsx
stats.categoryBreakdown.find((c) => c.name === "Feature Request")?.count || 0
stats.categoryBreakdown.find((c) => c.name === "Bug")?.count || 0
```

**Problem:** If the `categories` table row has `name = "Feature Requests"`
(plural) or `name = "bug"` (lower-case), the card always shows 0. The slugs
(`feature-request`, `bug`) are the stable identifiers; display names are
human-editable.

**Fix sketch:** Match on `c.slug` instead of `c.name`:

```tsx
stats.categoryBreakdown.find((c) => c.slug === "feature-request")?.count || 0
stats.categoryBreakdown.find((c) => c.slug === "bug")?.count || 0
```

**Status:** _still-open_. `app/page.tsx:176,185` still match on
`c.name === "Feature Request"` / `c.name === "Bug"`. Note: for the slug
fix to work end-to-end, `app/api/stats/route.ts` must also start
returning `slug` in `categoryBreakdown` (it currently only emits
`{ name, count, color }`).

---

### P1-4: Full-text search param `q` is wired in the hook but unreachable from UI

**File:** `hooks/use-dashboard-data.ts:122` and `app/page.tsx` (absent)

**Problem:** `useIssues` accepts a `q` parameter and passes it to
`/api/issues?q=…`, but `IssuesTable` has no search input and `handleFilterChange`
never sets `q`. The search capability is silently non-functional from the user's
perspective.

**Fix sketch:** Add a debounced `<Input>` above the issues table that calls
`handleFilterChange({ q: value })`, or remove `q` from the hook until it is
surfaced.

**Status:** _still-open_. `useIssues` still accepts `q`
(`hooks/use-dashboard-data.ts:106-122`) and no UI component sets it.

---

### P1-5: Ingestion upsert is a per-row loop — N sequential round-trips per scrape

**File:** `lib/scrapers/index.ts:65-70` and `lib/scrapers/index.ts:157-162`

**Problem:** Both `runAllScrapers` and `runScraper` iterate individual issues
and `await`s each upsert. For 100 new issues across 4 sources, this is 100+
sequential Postgres round-trips per scrape run. Under Vercel serverless limits
(10 s default) this causes frequent timeouts for large result sets.

**Fix sketch:** Use Supabase's bulk upsert:

```ts
await supabase
  .from("issues")
  .upsert(issues, { onConflict: "source_id,external_id", ignoreDuplicates: false })
```

**Status:** _still-open_. Both `runAllScrapers`
(`lib/scrapers/index.ts:76-82`) and `runScraper`
(`lib/scrapers/index.ts:168-173`) still `await` a single-row upsert per
issue. Fix sketch still applies; note that a bulk upsert will also make
the P0-5 `frequency_count` fix more awkward (needs a raw SQL expression
or a post-upsert update pass).

---

### P1-6: GitHub scraper only indexes `is:issue`, missing Discussions entirely — RESOLVED

**File:** `lib/scrapers/providers/github.ts:14,39`

**Problem:** GitHub Discussions (the primary channel for openai/codex user
feedback since the repo switched to Discussions in 2024) are not queryable via
`/search/issues`. The current scraper never surfaces any discussion threads,
missing a high-signal feedback channel.

**Resolution:** Added `lib/scrapers/providers/github-discussions.ts`, which
calls GitHub GraphQL `search(type: DISCUSSION)` against the same repo set as
the REST `github` scraper and degrades to a no-op when `GITHUB_TOKEN` is not
configured. Registered under slug `github-discussions` in
`lib/scrapers/index.ts` and seeded via
`scripts/005_add_github_discussions_and_openai_community_sources.sql`.
The same migration adds `openai-community` (community.openai.com / Discourse)
so the two highest-signal channels flagged in this item ship together.

**Status:** _addressed_.

---

### P1-7: Classifier triage queue is never auto-populated from the scraper loop

**File:** `lib/scrapers/index.ts` (absent) and `app/api/classify/route.ts`

**Problem:** The `/api/classify` endpoint exists and stores rows in
`bug_report_classifications`, but nothing calls it. The scraper loop upserts to
`issues` and stops. The triage panel therefore always renders empty unless an
external caller manually posts to `/api/classify`. The feature has no path to
value in production.

**Fix sketch:** After each successful upsert batch, call `/api/classify` for
issues with `severity_hint = "negative"` and `impact_score >= 6`, or add a
separate Vercel cron job that pulls unclassified high-impact issues and submits
them.

**Status:** _still-open_. `lib/scrapers/index.ts` still finishes at the
upsert and never calls `/api/classify`. Note that `impact_score >= 6`
as a trigger is now sentiment-inflated (PR #11 kept the 1.5× boost),
which will bias the triage queue toward negative-sentiment posts — a
feature in some sense, but worth stating explicitly when this lands.

---

### P1-9: PR #12 — re-scraping an existing cluster member never re-increments the canonical

**File:** `lib/scrapers/index.ts:45-54`

**Problem:** The canonical's `frequency_count` is bumped only on the
*first* insert of a new member (`lib/scrapers/index.ts:74-78`). When the
same Reddit / HN / GitHub post is rescraped on a later run, the code
hits the `existing` branch (matched on `source_id + external_id`), updates
the row in place, and never bumps the canonical. Over weekly scrapes, a
widely-discussed duplicate therefore contributes **1** to `frequency_count`,
not N — which contradicts the "true report volume" framing the Priority
Matrix communicates on its X-axis.

**Fix sketch:** Pick one semantic for `frequency_count`:

- **Distinct external posts** (smaller, cleaner): drop the increment
  entirely and rename the axis to "distinct reports".
- **Report volume over time** (larger, more useful for urgency): on the
  existing-row branch, emit a SQL increment on the canonical when a
  sensible "re-observation" signal fires (e.g. `updated_at` / `scraped_at`
  day has advanced since last seen).

**Status:** _still-open_ (new in PR #12).

---

### P1-10: PR #12 — title edits silently break cluster invariants (no rebalance)

**File:** `lib/scrapers/index.ts:45-54`

**Problem:** When an existing `(source_id, external_id)` row is rescraped
with a changed title (OPs edit titles), the existing branch recomputes
`cluster_key` and stamps it on the row without decrementing the old
canonical's `frequency_count`, updating `is_canonical`, or re-pointing
`canonical_issue_id`. If the edited row was itself a canonical, all its
members are orphaned — they still reference `canonical_issue_id` pointing
at a row that now lives in a different cluster. Aggregates drift
permanently.

**Fix sketch:** On `existing.cluster_key !== newClusterKey`, treat the
write as a move: detach from old cluster (decrement old canonical,
promote a new canonical if this row was the head) and reattach via the
same path a fresh insert uses. Cleanest as a `BEFORE UPDATE OF title`
trigger.

**Status:** _still-open_ (new in PR #12).

---

### P1-11: PR #12 — `ON DELETE SET NULL` on `canonical_issue_id` orphans the cluster

**File:** `scripts/002_create_issues_schema_v2.sql:48`

**Problem:** Deleting a canonical row nulls out `canonical_issue_id` on
every member, but each member still has `is_canonical = false`. Every
widget that filters `is_canonical = true` then excludes the entire
cluster — it disappears from Priority Matrix and related surfaces until
someone manually promotes a new canonical. `frequency_count` is lost.

**Fix sketch:** Add a `BEFORE DELETE ON issues WHERE is_canonical = true`
trigger that promotes the oldest remaining member (matching the
backfill's tie-breaker, `ORDER BY created_at ASC, id ASC`).
Alternatively, use `ON DELETE CASCADE` if canonicals should not be deleted
without dropping the cluster.

**Status:** _still-open_ (new in PR #12).

---

### P1-12: PR #12 — Unicode titles collapse into a single `title:empty` bucket

**File:** `lib/scrapers/shared.ts:317`

**Problem:** `title.replace(/[^a-z0-9\s]/g, " ")` strips everything
non-ASCII. Japanese, Chinese, Korean, Arabic, and Latin-1-accented titles
("café crashes Codex") lose their semantic content; all-CJK titles
normalize to the empty string and land in the single `"title:empty"`
bucket — every non-Latin report is merged into one giant pseudo-cluster
and the first such row becomes its canonical.

**Fix sketch:** Normalize Unicode and preserve letters across scripts:

```ts
title
  .toLowerCase()
  .normalize("NFKD")
  .replace(/\p{M}+/gu, "")           // strip combining marks
  .replace(/[^\p{L}\p{N}\s]+/gu, " ")// keep letters/numbers from any script
```

The SQL backfill needs the equivalent change so the two paths stay in
sync.

**Status:** _still-open_ (new in PR #12).

---

### P1-13: PR #12 — `cluster_key` is nullable, making the canonical-per-cluster invariant unenforceable

**File:** `scripts/002_create_issues_schema_v2.sql:47`

**Problem:** `cluster_key TEXT` is nullable. Combined with the lack of a
partial unique index, the database cannot express "one canonical per
cluster". Adding
`CREATE UNIQUE INDEX ON issues(cluster_key) WHERE is_canonical = true;`
only works reliably once `cluster_key NOT NULL DEFAULT 'title:empty'`
is in place (or it becomes a `GENERATED ALWAYS AS (...) STORED` column)
— otherwise multiple NULLs slip past the index.

**Fix sketch:**

```sql
ALTER TABLE issues ALTER COLUMN cluster_key SET NOT NULL;
-- or, better:
-- ADD COLUMN cluster_key TEXT GENERATED ALWAYS AS (...) STORED;
CREATE UNIQUE INDEX idx_unique_canonical_per_cluster
  ON issues(cluster_key) WHERE is_canonical = true;
```

**Status:** _addressed-in-PR-#12_ (commit `5f4b1ff`).
`scripts/006_clustering_invariants_and_rpc.sql` pins `cluster_key NOT
NULL DEFAULT 'title:empty'` and adds the partial unique index
`idx_issues_unique_canonical_per_cluster`. Fresh installs get the same
constraints from `scripts/002_create_issues_schema_v2.sql`.

---

### P1-8: Hacker News query uses boolean AND, not OR — too few results

**File:** `lib/scrapers/providers/hackernews.ts` (query string)

**Problem:** The Algolia HN search API treats space-separated terms as AND.
A query like `codex copilot "codex cli"` only matches posts that contain *all*
terms simultaneously. The fix from the last sprint (optionalWords) may or may
not have landed — verify the current query uses `OR`/`optionalWords` correctly,
or switch to multiple single-keyword requests merged client-side.

**Fix sketch:** Issue one request per keyword (`codex`, `copilot`) and merge
results, deduplicating on `objectID`.

**Status:** _addressed_. `lib/scrapers/providers/hackernews.ts:15-27`
now passes an empty `query` plus `optionalWords="codex copilot openai
codex cli openai codex"`, which gives the desired OR semantics in a
single request (simpler than per-keyword merge). Fix sketch's
alternative remains valid if Algolia relevance tuning degrades.

---

## P2 — Polish / UX gaps

### P2-1: Sortable table headers are not keyboard-accessible

**File:** `components/dashboard/issues-table.tsx:247-267`

**Problem:** Column sort headers are implemented as `<div onClick>` or similar
non-interactive elements. Users who navigate with a keyboard or assistive
technology cannot activate column sorting (no `tabIndex`, no `onKeyDown`, no
`role="button"` or `<button>` wrapper).

**Fix sketch:** Replace sort-trigger `<div>` with `<button>` elements and add
`aria-sort="ascending" | "descending" | "none"` on `<th>`.

**Status:** _still-open_.

---

### P2-2: Time-window slider has no accessible label

**File:** `components/dashboard/issues-table.tsx:207-222`

**Problem:** The days-range slider control is rendered without an `aria-label`
or visible `<label>` association. Screen readers announce it as an unlabelled
range input.

**Fix sketch:**

```tsx
<Slider
  aria-label="Time window in days"
  aria-valuetext={`${days} days`}
  ...
/>
```

**Status:** _still-open_.

---

### P2-4: Issues-table filter badge says "Cluster:" but renders the category label (pre-PR #12)

**File:** `components/dashboard/issues-table.tsx:137`

**Problem:** The header chip reads `Cluster: {globalCategoryLabel}` — it
labels itself as "Cluster" but displays the *category* filter value.
Predates PR #12 but surfaces more prominently now that there is an actual
cluster filter elsewhere in the dashboard, because a user clicking a
Priority Matrix point expects the chip to reflect the cluster-key filter.

**Fix sketch:** Either correct the label to `Category:` and add a separate
chip for the active cluster key (and the canonical's title + report
count), or drive the chip from `activeClusterKey` when present.

**Status:** _still-open_. Predates PR #12 but surfaces because PR #12
introduces a real cluster filter that the chip would otherwise reflect.

---

### P2-3: Dashboard footer still lists only "Reddit, Hacker News, GitHub" — Stack Overflow missing

**File:** `app/page.tsx:224`

```tsx
<p>Codex Issues Visualizer - Aggregating feedback from Reddit, Hacker News, GitHub, and more</p>
```

**Problem:** Stack Overflow was added as a scraper source but the footer copy
was not updated. Minor credibility issue for external stakeholders reviewing the
dashboard.

**Fix sketch:** Update copy to "Reddit, Hacker News, GitHub, Stack Overflow,
and more".

**Status:** _still-open (and now also missing GitHub Discussions + OpenAI
Community)_. `app/page.tsx:254-255` still reads "Reddit, Hacker News,
GitHub, and more". Since P1-6's resolution added two more sources, the
copy gap has widened. Updated fix: "Reddit, Hacker News, GitHub, GitHub
Discussions, Stack Overflow, OpenAI Community, and more" — or switch to
a dynamic list pulled from `/api/stats`'s `sourceBreakdown`.

---

## Summary table

| ID     | Priority | Status              | Area           | File                                      | One-liner                                      |
|--------|----------|---------------------|----------------|-------------------------------------------|------------------------------------------------|
| P0-1   | P0       | addressed           | Data quality   | `lib/scrapers/providers/reddit.ts:27`     | Reddit query uses scoped Codex phrases only    |
| P0-2   | P0       | addressed           | Sentiment      | `lib/scrapers/shared.ts`                  | Canonical lexicon + tokenized match (topic nouns no longer conflated) |
| P0-3   | P0       | addressed           | Analytics      | `shared.ts` + `realtime.ts`               | Double-count removed; impact now owns sentiment |
| P0-4   | P0       | addressed           | Analytics      | `lib/analytics/competitive.ts`            | Mention-window sentiment + null propagation (no fallback channel) |
| P0-5   | P0       | addressed-in-PR-#12 | Data model     | `index.ts` + `002_*.sql:46`               | `frequency_count` now bumped atomically via RPC; canonical-filtered aggregates |
| P0-6   | P0       | still-open          | Performance    | `app/api/stats/route.ts`                  | 6 un-cached full-table scans per page load     |
| P0-7   | P0       | addressed-in-PR-#12 | Analytics      | `app/api/stats/route.ts:27-90`            | All stats aggregates + default issues list now canonical-filtered |
| P0-8   | P0       | addressed-in-PR-#12 | Data integrity | `shared.ts:311` + `scripts/005_*.sql:16`  | TS now uses MD5 to match SQL backfill — cluster keys converge |
| P0-9   | P0       | addressed-in-PR-#12 | Data integrity | `scripts/005_*.sql:19,21`                 | Backfill regex now uses single-backslash `\s+` and matches whitespace |
| P0-10  | P0       | addressed-in-PR-#12 | Concurrency    | `lib/scrapers/index.ts:30-99`             | Partial unique index + atomic RPC + 23505 fall-through close all three races |
| P1-1   | P1       | still-open          | UX / errors    | `app/page.tsx:37`                         | Error and empty state look identical           |
| P1-2   | P1       | still-open          | UX / signal    | `app/page.tsx:142-175`                    | KPIs are all-time totals, no delta / window    |
| P1-3   | P1       | still-open          | Data quality   | `app/page.tsx:176,185`                    | Category KPI uses fragile display-name match   |
| P1-4   | P1       | still-open          | UX             | `hooks/use-dashboard-data.ts:122`         | Full-text search wired but unreachable from UI |
| P1-5   | P1       | still-open          | Performance    | `lib/scrapers/index.ts:76-82`             | Per-row upsert loop, N round-trips per scrape  |
| P1-6   | P1       | addressed           | Coverage       | `lib/scrapers/providers/github-discussions.ts` | GitHub Discussions + OpenAI Community scrapers |
| P1-7   | P1       | still-open          | Feature        | `lib/scrapers/index.ts` (absent)          | Classifier never auto-fed from scraper output  |
| P1-8   | P1       | addressed           | Coverage       | `lib/scrapers/providers/hackernews.ts:15-27` | HN query now uses `optionalWords` (OR)       |
| P1-9   | P1       | still-open (PR #12) | Data model     | `lib/scrapers/index.ts:45-54`             | Re-scrape of existing cluster member never re-increments canonical |
| P1-10  | P1       | still-open (PR #12) | Data model     | `lib/scrapers/index.ts:45-54`             | Title edits don't rebalance cluster / frequency / canonical linkage |
| P1-11  | P1       | still-open (PR #12) | Data integrity | `scripts/002_*.sql:48`                    | `ON DELETE SET NULL` orphans whole cluster on canonical deletion |
| P1-12  | P1       | still-open (PR #12) | Data quality   | `lib/scrapers/shared.ts:317`              | Unicode titles collapse to one `title:empty` bucket |
| P1-13  | P1       | addressed-in-PR-#12 | Schema         | `scripts/002_*.sql:47`                    | `cluster_key` is now NOT NULL + partial unique index on canonical rows |
| P2-1   | P2       | still-open          | Accessibility  | `components/dashboard/issues-table.tsx:247` | Sort headers not keyboard-accessible         |
| P2-2   | P2       | still-open          | Accessibility  | `components/dashboard/issues-table.tsx:207` | Slider has no aria-label                     |
| P2-3   | P2       | still-open          | Copy           | `app/page.tsx:254`                        | Footer omits Stack Overflow, Discussions, OpenAI Community |
| P2-4   | P2       | still-open          | UI correctness | `components/dashboard/issues-table.tsx:137` | Chip label reads "Cluster:" but renders category label (predates PR #12) |

## Discovered during PR #11 review (not yet prioritised)

| ID     | Priority | Status       | Area           | File                                      | One-liner                                      |
|--------|----------|--------------|----------------|-------------------------------------------|------------------------------------------------|
| N-1    | P1       | addressed    | UI drift       | `components/dashboard/realtime-insights.tsx:39` | Card description advertised "negative sentiment" as a weight — no longer true after PR #13 dropped the `negativeRatio*3` term. Copy now reads "volume + momentum + impact + source diversity"; see commit on `claude/fix-dashboard-urgency-card-eC2S4`. |
| N-2    | P2       | still-open   | Scoring        | `lib/scrapers/shared.ts:90-131`           | `keyword_presence` is returned, tested, and never consumed. Reviewer recommendation: drop from return type + delete test in a follow-up (simplest), or persist as a column if a consumer lands. Status quo invites future contributors to "fix" the field and break the tests. |
| N-3    | P2       | addressed    | Scoring        | `lib/scrapers/shared.ts`                  | Valence scoring now tokenizes (`lowerText.match(/[a-z']+/g)`) instead of `.includes()`, so `"bad"` no longer matches `"badge"` and `"fast"` no longer matches `"breakfast"`. Closed as a side effect of the PR #10 lexicon-unification merge. |
| N-4    | P2       | still-open   | Scoring        | All providers                             | `impact_score` engagement inputs (reactions, likes, answers, points, score) are unit-mismatched across sources — SO's `answer_count` is fed into the "comments" slot, etc. |
| N-5    | P3       | still-open   | Ops            | `scripts/003_*.sql`                       | Two migrations share the `003_` prefix (`003_add_stackoverflow_source.sql`, `003_create_bug_report_classifications.sql`). Tolerable but fragile for ordered runners. |
| N-6    | P1       | still-open   | Data migration | DB column `issues.impact_score`           | Old rows were written with the PR #11 pre-refactor sentiment logic (topic words forced negative → 1.5× boost applied widely). New rows are written with the narrower negative definition + same 1.5×. Until a re-score pass runs, the `issues` table is heterogeneous; dashboards mixing old + new rows will show a gradual downward drift in bug-category `avgImpact` as old rows age out of the 6-day window. Draft migration artifacts are now available at `scripts/006_rescore_impact_after_pr13.ts` and `scripts/006_rescore_impact_after_pr13.sql` (with dry-run report output to `scripts/tmp/rescore-YYYYMMDD.json`), but status remains still-open until a reviewed production apply completes. |
| N-7    | P2       | still-open   | Tests          | `tests/scoring-pipeline.test.ts`          | Coverage gaps surfaced by the #13 review: (a) no isolated test asserts the 1.5× negative-sentiment boost in `calculateImpactScore` — the PR's key semantic claim; (b) no boundary tests for `upvotes=0`/`comments=0` (should clamp to 1) or very high engagement (should clamp to 10); (c) no negative test proving `keyword_presence` does NOT feed urgency or impact; (d) the substring-match flaw (N-3) is documented but not characterized, so a "fix" would silently break N-3's current behavior. |

---

## PR #13 review ledger

Two rounds of review have landed on this branch:

1. **Senior-engineer subagent review** (2026-04-20). Systemic pipeline trace, surfaced N-1 through N-5, produced `docs/SCORING.md`.
2. **Independent Claude review** (2026-04-20, post-rebase onto `main`). Verdict: **Merge with follow-ups. Zero blockers. Human senior engineer review explicitly not required for this PR** — the reviewer's rationale: the refactor is scoped to three files in a domain that already has two rounds of documented review, the math is straightforward, tests pass, and the DB heterogeneity risk is contained and recoverable.

New findings from the #13 review are logged above as **N-6** (impact_score heterogeneity / re-score gap) and **N-7** (test coverage gaps).

The reviewer's "should-fix before merge" list — which this PR does NOT include (all deferred as follow-ups, none are blockers):
- **N-1**: one-line UI copy fix in `components/dashboard/realtime-insights.tsx:39`.
- **N-2**: decide `keyword_presence` fate (remove vs. persist).
- **N-6**: release note or re-score job for `impact_score` heterogeneity.

## PR #10 merge-into-main note

When PR #10 merged, two items flipped status as documented above:
- **P0-2** → `addressed`. PR #11 fixed topic-noun contamination at the
  polarity layer; PR #10 finished the job by having `analyzeSentiment`
  consume the canonical `lib/analytics/sentiment-lexicon.ts` and switching
  substring matching to whole-token matching (which also closes N-3).
- **P0-4** → `addressed`. Mention-window sentiment, nullable contract,
  and the removal of the `fallbackSentiment` back-channel together
  close the co-mentioned-competitor attribution bug.

---

## PR #12 review ledger

Two independent follow-up reviews (2026-04-21) on `claude/review-edge-cases-sCBSO`:

1. **Data-accuracy review** — surfaced the cross-widget double-count regression (P0-7), the re-scrape-never-re-increments bug (P1-9), and the concurrency race modes (P0-10). Also flagged the nondeterministic `maybeSingle()` canonical lookup when rivals exist.
2. **Plan-alignment / design review** — surfaced the SHA-1 vs MD5 hash mismatch between TS runtime and SQL backfill (P0-8), the nullable `cluster_key` schema gap (P1-13), and pushed back usefully on the `is_canonical DEFAULT TRUE` concern (fine — persist path writes the flag explicitly).

Verdict: **Needs changes** (not redesign). The direction is right — drilldown flow works end-to-end and the data model is sound — but the three P0s (P0-7, P0-8, P0-10) and the clustering-specific P1s should land before merge.

**Follow-up (2026-04-21):** commit `5f4b1ff` on the PR branch closes all four P0 blockers (P0-7, P0-8, P0-9, P0-10) — see each entry's Status line. Remaining PR-#12 scope is the P1 backlog (P1-9 re-scrape re-increment, P1-10 title-edit rebalance, P1-11 canonical-deletion orphaning, P1-12 Unicode collapse, P1-13 is now moot — cluster_key is NOT NULL after commit `5f4b1ff`).
