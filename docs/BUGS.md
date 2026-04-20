# Bug & Issues Backlog

_Generated: 2026-04-20 from two independent senior-engineer end-to-end reviews._
_Branch: `claude/audit-data-collection-dPDcG`_

Each entry includes priority, a one-sentence description, the exact file:line
reference, and a minimal fix sketch. Priorities follow the standard
P0 (data-corrupt / silent wrong answer) → P1 (significant quality loss) →
P2 (polish / UX gap) scale.

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

---

### P0-2: Sentiment signal conflates functional words with emotional words — ✅ addressed in PR #11

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
`NEGATIVE_KEYWORD_PATTERNS` and exposes the count as `keyword_presence` on
`analyzeSentiment`'s return (currently unconsumed — follow-up needed to wire it
into impact/urgency). Note: `"broken"` and `"unusable"` are valence words from
the original fix sketch but were also dropped from `negativeWords`; consider
restoring them if sentiment detection proves under-sensitive in production.

---

### P0-3: Negative-sentiment bias is double-counted in urgency score — ✅ addressed in PR #11

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

---

## Summary table

| ID     | Priority | Area           | File                                      | One-liner                                      |
|--------|----------|----------------|-------------------------------------------|------------------------------------------------|
| P0-1   | P0       | Data quality   | `lib/scrapers/providers/reddit.ts:27`     | Bare `copilot` query matches unrelated products |
| P0-2   | P0       | Sentiment      | `lib/scrapers/shared.ts:79-84`            | Topic nouns inflate negative-sentiment count   |
| P0-3   | P0       | Analytics      | `shared.ts:255` + `realtime.ts:124`       | Negative bias double-counted in urgency score  |
| P0-4   | P0       | Analytics      | `lib/analytics/competitive.ts:55-80`      | Co-mentioned competitors share same sentiment  |
| P0-5   | P0       | Data model     | `index.ts:65` + `sql:46`                  | `frequency_count` never increments, always 1  |
| P0-6   | P0       | Performance    | `app/api/stats/route.ts:27-138`           | 6 un-cached full-table scans per page load     |
| P1-1   | P1       | UX / errors    | `app/page.tsx:111`                        | Error and empty state look identical           |
| P1-2   | P1       | UX / signal    | `app/page.tsx:142-175`                    | KPIs are all-time totals, no delta / window    |
| P1-3   | P1       | Data quality   | `app/page.tsx:156,166`                    | Category KPI uses fragile display-name match   |
| P1-4   | P1       | UX             | `hooks/use-dashboard-data.ts:122`         | Full-text search wired but unreachable from UI |
| P1-5   | P1       | Performance    | `lib/scrapers/index.ts:65-70`             | Per-row upsert loop, N round-trips per scrape  |
| P1-6   | P1       | Coverage       | `lib/scrapers/providers/github.ts:14`     | GitHub Discussions not scraped — RESOLVED (+ OpenAI Community) |
| P1-7   | P1       | Feature        | `lib/scrapers/index.ts` (absent)          | Classifier never auto-fed from scraper output  |
| P1-8   | P1       | Coverage       | `lib/scrapers/providers/hackernews.ts`    | HN query too restrictive (possible AND issue)  |
| P2-1   | P2       | Accessibility  | `components/dashboard/issues-table.tsx:247` | Sort headers not keyboard-accessible         |
| P2-2   | P2       | Accessibility  | `components/dashboard/issues-table.tsx:207` | Slider has no aria-label                     |
| P2-3   | P2       | Copy           | `app/page.tsx:224`                        | Footer omits Stack Overflow from source list   |
