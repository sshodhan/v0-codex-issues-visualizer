# Bug & Issues Backlog

_Generated: 2026-04-20 from two independent senior-engineer end-to-end reviews._
_Last reviewed: 2026-04-20 on branch `claude/review-pr-11-SPlkP` (after PR #11 + stacked improvements)._

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

**File:** `lib/scrapers/shared.ts:79-84`

**Problem:** `negativeWords` includes `"bug"`, `"error"`, `"issue"`,
`"problem"`. These are topic words (the post *is about* a bug), not valence
words. Every post in the "Bug" category is pre-loaded with negative sentiment
regardless of tone. This cascades into `calculateImpactScore` (1.5× multiplier,
`shared.ts:255`) **and** the urgency formula (negativeRatio×3,
`realtime.ts:124`), double-penalising bug-category issues.

```ts
// fix — remove topic nouns from negativeWords, keep only valence adjectives
// Remove: "bug", "error", "crash", "issue", "problem", "fail"
// Keep:   "hate", "terrible", "awful", "bad", "worst", "broken",
//         "frustrating", "annoying", "disappointing", "unusable"
```

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

**File:** `lib/analytics/competitive.ts:55-80`

**Problem:** If one post mentions both `cursor` and `windsurf`, the inner loop
attributes the post's sentiment to both competitors. A post saying "Cursor is
much better than Windsurf" is logged as a positive signal for Cursor *and* a
positive signal for Windsurf. Net-sentiment bars in the dashboard are therefore
misleading whenever two competitors appear in the same post.

**Fix sketch:** Either attribute only to competitors the sentence polarity
points toward (hard), or deduplicate per-post: only mark the first matched
competitor (simple) or skip sentiment attribution when `>1` competitor is
matched (conservative).

**Status:** _still-open_. `lib/analytics/competitive.ts:55-92` still loops
`for (const [competitor] of Object.entries(COMPETITOR_KEYWORDS))` and
attributes sentiment to every matched competitor. PR #11 and its stack did
not touch this file. Fix sketch still applies.

---

### P0-5: `frequency_count` is never aggregated — always shows 1

**File:** `scripts/002_create_issues_schema_v2.sql:46` and
`lib/scrapers/index.ts:65-70`

**Problem:** The column default is 1 and the upsert
`ignoreDuplicates: false` updates every field except `frequency_count`. Nothing
ever increments it. The Priority Matrix X-axis (`components/dashboard/priority-matrix.tsx:35,49`)
uses `frequency_count` as the frequency dimension, so every issue sits at x=1:
the chart renders a vertical column of dots rather than a scatter, providing no
frequency signal.

**Fix sketch:**

```sql
-- migration
ALTER TABLE issues ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
```

```ts
// in upsert options
mergeColumns: ["title","content","sentiment","impact_score","upvotes",
               "comments_count","last_seen_at"],
// plus a raw SQL increment:
// frequency_count = issues.frequency_count + 1
```

**Status:** _still-open_. `lib/scrapers/index.ts:76-82` still calls
`upsert(issue, { onConflict, ignoreDuplicates: false })` with no
`frequency_count` handling. Priority Matrix is therefore still a vertical
line at x=1. Fix sketch still applies; note this also blocks a
dedupe-to-`issues.frequency_count` strategy for cross-source clustering.

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

| ID     | Priority | Status       | Area           | File                                      | One-liner                                      |
|--------|----------|--------------|----------------|-------------------------------------------|------------------------------------------------|
| P0-1   | P0       | still-open   | Data quality   | `lib/scrapers/providers/reddit.ts:27`     | Bare `copilot` query matches unrelated products |
| P0-2   | P0       | partial      | Sentiment      | `lib/scrapers/shared.ts`                  | Topic nouns fixed; `keyword_presence` unconsumed |
| P0-3   | P0       | addressed    | Analytics      | `shared.ts` + `realtime.ts`               | Double-count removed; impact now owns sentiment |
| P0-4   | P0       | still-open   | Analytics      | `lib/analytics/competitive.ts:55-92`      | Co-mentioned competitors share same sentiment  |
| P0-5   | P0       | still-open   | Data model     | `index.ts` + `002_*.sql:46`               | `frequency_count` never increments, always 1  |
| P0-6   | P0       | still-open   | Performance    | `app/api/stats/route.ts`                  | 6 un-cached full-table scans per page load     |
| P1-1   | P1       | still-open   | UX / errors    | `app/page.tsx:37`                         | Error and empty state look identical           |
| P1-2   | P1       | still-open   | UX / signal    | `app/page.tsx:142-175`                    | KPIs are all-time totals, no delta / window    |
| P1-3   | P1       | still-open   | Data quality   | `app/page.tsx:176,185`                    | Category KPI uses fragile display-name match   |
| P1-4   | P1       | still-open   | UX             | `hooks/use-dashboard-data.ts:122`         | Full-text search wired but unreachable from UI |
| P1-5   | P1       | still-open   | Performance    | `lib/scrapers/index.ts:76-82`             | Per-row upsert loop, N round-trips per scrape  |
| P1-6   | P1       | addressed    | Coverage       | `lib/scrapers/providers/github-discussions.ts` | GitHub Discussions + OpenAI Community scrapers |
| P1-7   | P1       | still-open   | Feature        | `lib/scrapers/index.ts` (absent)          | Classifier never auto-fed from scraper output  |
| P1-8   | P1       | addressed    | Coverage       | `lib/scrapers/providers/hackernews.ts:15-27` | HN query now uses `optionalWords` (OR)       |
| P2-1   | P2       | still-open   | Accessibility  | `components/dashboard/issues-table.tsx:247` | Sort headers not keyboard-accessible         |
| P2-2   | P2       | still-open   | Accessibility  | `components/dashboard/issues-table.tsx:207` | Slider has no aria-label                     |
| P2-3   | P2       | still-open   | Copy           | `app/page.tsx:254`                        | Footer omits Stack Overflow, Discussions, OpenAI Community |

## Discovered during PR #11 review (not yet prioritised)

| ID     | Priority | Status       | Area           | File                                      | One-liner                                      |
|--------|----------|--------------|----------------|-------------------------------------------|------------------------------------------------|
| N-1    | P1       | still-open   | UI drift       | `components/dashboard/realtime-insights.tsx:39` | Card description advertises "negative sentiment" as a weight — no longer true |
| N-2    | P2       | still-open   | Scoring        | `lib/scrapers/shared.ts:90-131`           | `keyword_presence` is returned, tested, and never consumed (see `docs/SCORING.md`) |
| N-3    | P2       | still-open   | Scoring        | `lib/scrapers/shared.ts:107-130`          | Valence words use `.includes(word)` substring match (`"bad"` matches `"badge"`) |
| N-4    | P2       | still-open   | Scoring        | All providers                             | `impact_score` engagement inputs (reactions, likes, answers, points, score) are unit-mismatched across sources — SO's `answer_count` is fed into the "comments" slot, etc. |
| N-5    | P3       | still-open   | Ops            | `scripts/003_*.sql`                       | Two migrations share the `003_` prefix (`003_add_stackoverflow_source.sql`, `003_create_bug_report_classifications.sql`). Tolerable but fragile for ordered runners. |
