# Bug & Issues Backlog

- **Origin:** two independent senior-engineer end-to-end reviews, merged via [PR #6](https://github.com/sshodhan/v0-codex-issues-visualizer/pull/6) on 2026-04-20.
- **Last updated:** 2026-04-20 — status tracking, PR cross-references, entry template, and quick index added.

Each entry includes priority, status, a one-line description, a `file:line`
reference, and a minimal fix sketch. Priorities follow the standard
P0 (data-corrupt / silent wrong answer) → P1 (significant quality loss) →
P2 (polish / UX gap) scale.

## Quick index

- [P0 — Data integrity / silent wrong answers](#p0--data-integrity--silent-wrong-answers) — P0-1 … P0-6
- [P1 — Significant quality or correctness loss](#p1--significant-quality-or-correctness-loss) — P1-1 … P1-8
- [P2 — Polish / UX gaps](#p2--polish--ux-gaps) — P2-1 … P2-3
- [Summary table](#summary-table) — status at a glance
- [Reporting a new issue](#reporting-a-new-issue) — entry template
- [Change log](#change-log)

## How to use this document

This is a living backlog, not a one-shot audit.

- **Cross-reference IDs in PRs.** When opening a PR that touches an entry,
  mention the ID (e.g. `P0-1`) in the PR description so the link is
  bi-directional. When a PR lands, update the entry's **Status**,
  **Addressed by**, and the row in the [Summary table](#summary-table).
- **Never delete resolved entries.** They are the best defence against
  regressions — a future reader can see the prior failure mode. Mark them
  `Resolved` with the PR link and keep the body intact.
- **Keep `file:line` references honest.** Line numbers drift as the codebase
  changes. If you touch an entry, re-verify the anchor; if it's stale, update
  it in the same PR.

### Moving an entry to `Resolved`

Before flipping status to `Resolved`, confirm all of:

- [ ] The fix has landed on `main` (not just the PR branch).
- [ ] The `file:line` reference still points at the relevant code (often the
      line number changes post-fix — update it or remove it if the file is
      gone).
- [ ] A regression test exists for the failure mode, or the entry body notes
      explicitly why one is impractical.
- [ ] The [Summary table](#summary-table) row is updated and the PR is added
      to the [Change log](#change-log).

### Status legend

| Status        | Meaning                                                                    |
|---------------|----------------------------------------------------------------------------|
| `Open`        | Reported, not yet being worked on.                                         |
| `In progress` | A PR is open that proposes a fix; verify the linked PR before duplicating. |
| `Resolved`    | Fix has landed on `main`. Entry kept for historical context.               |
| `Wontfix`     | Deliberately deferred; rationale captured in the entry body.               |

---

## P0 — Data integrity / silent wrong answers

### P0-1: Reddit query matches all Microsoft Copilot products, not just Codex-adjacent ones

- **Status:** In progress
- **Addressed by:** [PR #8](https://github.com/sshodhan/v0-codex-issues-visualizer/pull/8)
- **File:** `lib/scrapers/providers/reddit.ts:27`

**Problem:** The bare term `copilot` in the OR query matches posts about
Microsoft 365 Copilot, Windows Copilot, Power Platform Copilot, etc.
`isLikelyCodexIssue()` only re-checks title+selftext after the API returns, so
Reddit already limits the result set to 25 posts per subreddit before the
client-side filter runs. Posts about unrelated Copilot products consume budget
and inflate issue counts.

```ts
// current (main)
'(codex OR copilot OR "openai codex" OR "codex cli")'

// proposed in PR #8 — scope query terms to Codex-adjacent phrases and add
// explicit exclusion patterns in the new relevance evaluator.
// See lib/scrapers/relevance.ts::REDDIT_SCOPED_QUERY_TERMS
'("openai codex" OR "chatgpt codex" OR "codex cli" OR "openai/codex" OR "codex terminal")'
```

Verify on merge: the new relevance evaluator must also reject the captured
false-positive samples in `lib/scrapers/relevance.test.ts` (Microsoft Copilot
for Sales, Power Platform Copilot, Copilot for M365, etc.).

---

### P0-2: Sentiment signal conflates functional words with emotional words

- **Status:** Open
- **File:** `lib/scrapers/shared.ts:79-84`

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

---

### P0-3: Negative-sentiment bias is double-counted in urgency score

- **Status:** Open
- **File:** `lib/scrapers/shared.ts:251-256` and `lib/analytics/realtime.ts:119-127`

**Problem:** `calculateImpactScore` already applies a 1.5× multiplier for
negative sentiment, inflating `impact_score` at ingestion time. The urgency
formula then adds `negativeRatio * 3` on top of `avgImpact * 1.0`.
A bug-category issue receives the sentiment penalty twice — once in its stored
`impact_score` and again in the ratio term. This causes bug-category urgency
scores to be materially overstated vs. feature-request or performance issues.

**Fix sketch:** Remove the `sentimentBoost` multiplier from
`calculateImpactScore` (store a pure engagement score) and let the urgency
formula own the full sentiment weighting.

---

### P0-4: Competitive sentiment is attributed to *all* co-mentioned competitors

- **Status:** Open
- **File:** `lib/analytics/competitive.ts:55-80`

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

- **Status:** Open
- **File:** `scripts/002_create_issues_schema_v2.sql:46` and `lib/scrapers/index.ts:65-70`

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

- **Status:** Open
- **File:** `app/api/stats/route.ts:27-138`
- **Note:** Priority is debatable — this is a cost/latency problem, not a
  data-correctness one. Kept at P0 because Supabase compute quota exhaustion
  can take the whole dashboard offline under load. Downgrade to P1 if that
  risk is mitigated by a different route.

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

- **Status:** Open
- **File:** `app/page.tsx:111`

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

- **Status:** Open
- **File:** `app/page.tsx:142-175`

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

- **Status:** Open
- **File:** `app/page.tsx:156,166`

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

- **Status:** Open
- **File:** `hooks/use-dashboard-data.ts:122` and `app/page.tsx` (absent)

**Problem:** `useIssues` accepts a `q` parameter and passes it to
`/api/issues?q=…`, but `IssuesTable` has no search input and `handleFilterChange`
never sets `q`. The search capability is silently non-functional from the user's
perspective.

**Fix sketch:** Add a debounced `<Input>` above the issues table that calls
`handleFilterChange({ q: value })`, or remove `q` from the hook until it is
surfaced.

---

### P1-5: Ingestion upsert is a per-row loop — N sequential round-trips per scrape

- **Status:** Open
- **File:** `lib/scrapers/index.ts:65-70` and `lib/scrapers/index.ts:157-162`

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

### P1-6: GitHub scraper only indexes `is:issue`, missing Discussions entirely

- **Status:** Open
- **File:** `lib/scrapers/providers/github.ts:14,39`

**Problem:** GitHub Discussions (the primary channel for openai/codex user
feedback since the repo switched to Discussions in 2024) are not queryable via
`/search/issues`. The current scraper never surfaces any discussion threads,
missing a high-signal feedback channel.

**Fix sketch:** Add a second fetch to the GitHub GraphQL Discussions search
endpoint (`POST /graphql` with `search(type: DISCUSSION, query: "…")`), or at
minimum document the gap in the scraper comment.

---

### P1-7: Classifier triage queue is never auto-populated from the scraper loop

- **Status:** Open
- **File:** `lib/scrapers/index.ts` (absent) and `app/api/classify/route.ts`

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

### P1-8: Hacker News query keyword set is too broad

- **Status:** In progress
- **Addressed by:** [PR #8](https://github.com/sshodhan/v0-codex-issues-visualizer/pull/8)
- **File:** `lib/scrapers/providers/hackernews.ts:15-16`

**Problem (original):** The Algolia HN search API treats space-separated terms
as AND. A query like `codex copilot "codex cli"` only matches posts that
contain *all* terms simultaneously.

**Current state (main):** OR semantics are correct — `optionalWords` is passed
and `QUERY` is empty, so the keyword set matches disjunctively. However the
keyword set (`codex`, `copilot`, `openai`, `codex cli`, `openai codex`) is far
too broad: bare `codex` matches historical/manuscript posts and bare `copilot`
matches every Microsoft Copilot SKU.

**Proposed (PR #8):** Narrow the required query to `"openai codex"` and keep a
scoped `optionalWords` set (`chatgpt codex`, `codex cli`, `openai/codex`,
`codex terminal`). Post-filter through the new relevance evaluator to capture
a `relevance_reason` for each accepted hit.

Verify on merge: confirm HN still returns a reasonable volume of stories —
the tightened required term changes recall characteristics. If recall is
poor, fall back to an empty `QUERY` with the scoped list moved entirely into
`optionalWords`.

---

## P2 — Polish / UX gaps

### P2-1: Sortable table headers are not keyboard-accessible

- **Status:** Open
- **File:** `components/dashboard/issues-table.tsx:247-267`

**Problem:** Column sort headers are implemented as `<div onClick>` or similar
non-interactive elements. Users who navigate with a keyboard or assistive
technology cannot activate column sorting (no `tabIndex`, no `onKeyDown`, no
`role="button"` or `<button>` wrapper).

**Fix sketch:** Replace sort-trigger `<div>` with `<button>` elements and add
`aria-sort="ascending" | "descending" | "none"` on `<th>`.

---

### P2-2: Time-window slider has no accessible label

- **Status:** Open
- **File:** `components/dashboard/issues-table.tsx:207-222`

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

- **Status:** Open
- **File:** `app/page.tsx:224`

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

| ID   | Priority | Status       | Area          | File                                        | One-liner                                       | Addressed by |
|------|----------|--------------|---------------|---------------------------------------------|-------------------------------------------------|--------------|
| P0-1 | P0       | In progress  | Data quality  | `lib/scrapers/providers/reddit.ts:27`       | Bare `copilot` query matches unrelated products | [#8](https://github.com/sshodhan/v0-codex-issues-visualizer/pull/8) |
| P0-2 | P0       | Open         | Sentiment     | `lib/scrapers/shared.ts:79-84`              | Topic nouns inflate negative-sentiment count    | —            |
| P0-3 | P0       | Open         | Analytics     | `shared.ts:255` + `realtime.ts:124`         | Negative bias double-counted in urgency score   | —            |
| P0-4 | P0       | Open         | Analytics     | `lib/analytics/competitive.ts:55-80`        | Co-mentioned competitors share same sentiment   | —            |
| P0-5 | P0       | Open         | Data model    | `index.ts:65` + `sql:46`                    | `frequency_count` never increments, always 1    | —            |
| P0-6 | P0       | Open         | Performance   | `app/api/stats/route.ts:27-138`             | 6 un-cached full-table scans per page load      | —            |
| P1-1 | P1       | Open         | UX / errors   | `app/page.tsx:111`                          | Error and empty state look identical            | —            |
| P1-2 | P1       | Open         | UX / signal   | `app/page.tsx:142-175`                      | KPIs are all-time totals, no delta / window     | —            |
| P1-3 | P1       | Open         | Data quality  | `app/page.tsx:156,166`                      | Category KPI uses fragile display-name match    | —            |
| P1-4 | P1       | Open         | UX            | `hooks/use-dashboard-data.ts:122`           | Full-text search wired but unreachable from UI  | —            |
| P1-5 | P1       | Open         | Performance   | `lib/scrapers/index.ts:65-70`               | Per-row upsert loop, N round-trips per scrape   | —            |
| P1-6 | P1       | Open         | Coverage      | `lib/scrapers/providers/github.ts:14`       | GitHub Discussions not scraped                  | —            |
| P1-7 | P1       | Open         | Feature       | `lib/scrapers/index.ts` (absent)            | Classifier never auto-fed from scraper output   | —            |
| P1-8 | P1       | In progress  | Coverage      | `lib/scrapers/providers/hackernews.ts:15`   | HN keyword set too broad; OR semantics OK       | [#8](https://github.com/sshodhan/v0-codex-issues-visualizer/pull/8) |
| P2-1 | P2       | Open         | Accessibility | `components/dashboard/issues-table.tsx:247` | Sort headers not keyboard-accessible            | —            |
| P2-2 | P2       | Open         | Accessibility | `components/dashboard/issues-table.tsx:207` | Slider has no aria-label                        | —            |
| P2-3 | P2       | Open         | Copy          | `app/page.tsx:224`                          | Footer omits Stack Overflow from source list    | —            |

## Reporting a new issue

Append new entries under the appropriate priority section, use the next free
ID in that band (e.g. the next P1 after P1-8 is `P1-9`), and add a row to the
[Summary table](#summary-table). Use this skeleton:

```md
### P?-N: <one-line title in sentence case>

- **Status:** Open
- **File:** `<path>:<line>` (multiple lines ok, use commas)

**Problem:** <2–5 sentences. State the failure mode and its user-visible
impact. If priority is debatable, say so here and justify the band.>

**Fix sketch:** <Smallest plausible change. A code block is fine but not
required — a pointer to the right function/file often suffices.>
```

Guidance:

- **Priority band.** P0 = silently wrong output or data corruption.
  P1 = materially wrong but visible (missing feature, poor perf, bad UX that
  users will notice). P2 = polish, a11y, copy, minor cosmetic.
- **Title.** Lead with the symptom, not the fix. "KPI cards show all-time
  totals" beats "Add 7-day window to KPIs".
- **`file:line`.** Prefer the tightest range that frames the bug. If the
  issue is architectural (no single line), point at the function or write
  `(absent)` and explain.

---

## Change log

- **2026-04-20** — Second pass: converted per-entry metadata to bullet lists
  so Status / Addressed-by / File render on separate lines on GitHub. Added
  a quick index, a "Reporting a new issue" template, and a
  "Moving an entry to Resolved" checklist. Tightened the P1-8 title and
  flagged P0-6 as priority-debatable.
- **2026-04-20** — First pass: added status tracking, PR cross-references,
  a legend, and a "How to use" section. Linked P0-1 and P1-8 to
  [PR #8](https://github.com/sshodhan/v0-codex-issues-visualizer/pull/8).
  Clarified P1-8: OR semantics on `main` are already correct via
  `optionalWords`; the live concern is keyword scope, not boolean mode.
