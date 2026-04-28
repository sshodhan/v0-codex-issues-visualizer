# "Other Hot Themes" — top-6 cap proposal

Investigation date: 2026-04-28
Branch: `claude/fix-hot-themes-limit-dUtT2`
Status: implemented in commits `5a0e88e` (cap removal + hot/quiet partition +
tests + doc updates) and the follow-up commit on this branch (filter copy
fix + `dashboard-hot-themes-filter-empty` breadcrumb).

## TL;DR

The `slice(0, 6)` in `lib/analytics/realtime.ts:171` and the `windowHours = 72`
default on the same function (`lib/analytics/realtime.ts:54`) **were never
designed against an explicit coverage requirement**. They were carried in with
the original analytics module (commit `98777da`, PR #91) and the cap is only
mentioned descriptively in `docs/SCORING.md:387` ("The top 6 categories by
`urgencyScore` are returned…") with no rationale. ARCHITECTURE.md §6.2
documents the formula but is silent on the cap.

The dashboard now has 11 topic slugs (v3 added `model-quality` in
`scripts/023_add_model_quality_category.sql`) and the panel today renders
exactly 1 lead + ≤5 followers = ≤6 categories. With the 2026-04-28 spot data,
**4 categories with active observations (`api`, `security`, `model-quality`,
`documentation`) are unreachable from the Triage tab without changing
filters**. That is the symptom worth fixing.

**Recommendation: split the surface.** Keep the urgency-ranked lead story as
the headline and replace "Other Hot Themes" with an always-visible,
all-categories grid sorted by urgency, with a "Quiet" subgroup for buckets
below an activity threshold. Keep the 72h window for both surfaces — see §3.

---

## 1. Decision: is the cap intentional?

**Incidental, not intentional.**

Evidence:

1. **No design note in PR #91.** The whole `lib/analytics/realtime.ts` file
   (144 lines including the `.slice(0, 6)` and `windowHours = 72`) lands in a
   single merge commit titled "Admin classify-backfill resilience + structured
   lifecycle logging" — the urgency module was bundled with unrelated work.
   No PR description, commit message, or in-tree design doc justifies the
   number 6.
2. **Docs only describe the cap, never defend it.** `docs/SCORING.md:387`
   states the cap exists in present tense; `docs/ARCHITECTURE.md` §6.2
   (lines 676–705) documents weights, lists future improvements, and
   pointedly does **not** mention the cap at all.
3. **Taxonomy out-grew the cap.** The 007 seed shipped with 10 categories
   (`scripts/007_three_layer_split.sql:730-738`); v3 added `model-quality`
   bringing the total to 11. The cap was not revisited.
4. **The grid component reapplies its own `slice(0, 6)`**
   (`components/dashboard/category-issues-grid.tsx:190`) — a defensive cap
   that confirms the upstream cap was incidental enough that downstream
   consumers re-implemented it locally rather than rely on the contract.

The 72h window is **partially intentional**. The realtime panel is
deliberately decoupled from the user's time chip (7d / 14d / 30d / All) —
`/api/stats/route.ts:331-353` always pulls a 6-day slice and feeds the inner
72h to `computeRealtimeInsights` regardless of `globalDays`. ARCHITECTURE.md
§6.2 describes urgency as a "hot now" signal distinct from the
user-controlled time chip. The 72h length itself is undocumented but
plausibly tied to two scrape-cron ticks (`0 */6 * * *` from `vercel.json`
gives 12 ticks per 72h, comfortable headroom).

**Verdict:** keep the 72h window. Drop or restructure the 6-cap.

## 2. What the user loses today

For the reviewer scenario "*are there any unread security incidents this
week?*", with the 2026-04-28 data:

| slug           | last_72h | visible? |
|----------------|----------|----------|
| integration    | 18       | yes (#1+) |
| bug            | 11       | yes |
| feature-request| 10       | yes (lead) |
| performance    | 8        | yes |
| ux-ui          | 7        | yes |
| other          | 3        | maybe (#6) |
| pricing        | 3        | maybe |
| **documentation** | **2**  | **no** |
| **api**        | **1**    | **no** |
| **security**   | **1**    | **no** |
| **model-quality** | **1** | **no** |

The reviewer cannot answer "any security signals?" from the Triage tab. They
have to switch the topic chip to "Security" — at which point a second bug
surfaces: `computeHeroInsight(realtimeInsights, globalCategory)` filters the
**already-truncated** array (`app/page.tsx:690`), so if Security wasn't in
the top 6 there is no row for `globalCategory === "security"` to match, and
the hero card returns `null`. The user gets an empty hero AND an unfiltered
"Other Hot Themes" grid (the grid does not consume `globalCategory`,
`app/page.tsx:953-957`). Their filter does nothing visible.

This is the bug worth describing in the deliverable: **the cap turns a
classifier-coverage question into a usability dead end**.

## 3. Recommendation

### 3.1 API contract change

Split `realtimeInsights` semantics in `lib/analytics/realtime.ts` from
**"top-6 by urgency, filtered to nowCount > 0"** to:

- Return **all categories with `nowCount + previousCount > 0` in the 6-day
  pulled window**, sorted by `urgencyScore` desc.
- Drop the `.slice(0, 6)` cap entirely. The `nowCount > 0` filter on line 134
  stays — a category with zero observations in the last 72h has no urgency
  signal to compute and an empty `topIssues` list, so it's not useful in this
  surface (see §3.4 for where empty buckets do belong).
- No other math changes (urgency formula, decay, momentum stay identical).

Caller migration:

| consumer | current behaviour | after |
|----------|-------------------|-------|
| `app/page.tsx:690` `computeHeroInsight(insights, globalCategory)` | filters truncated list; can return null when filter slug isn't in top-6 | filters full list; only returns null when no observations at all |
| `components/dashboard/category-issues-grid.tsx:190` `slice(0, 6)` | redundant local cap | remove the cap; render all rows |
| `components/dashboard/realtime-insights.tsx` | renders all (unbounded) | unchanged behaviour, but the input now contains every active category |
| `components/dashboard/hero-insight.tsx:436` `top = filteredInsights[0]` | reads index 0 of capped list | unchanged — still picks the urgency-#1 |

The lead story / followers split is preserved end-to-end. No double-count: the
panel filters the lead's slug out via `skipFirstCategorySlug` on
`category-issues-grid.tsx:185-187` and `realtime-insights.tsx:34-36`. That
behaviour is correct today and stays correct.

### 3.2 UI treatment

Two-tier grid in `CategoryIssuesGrid`:

1. **Hot themes** — categories with `nowCount >= HOT_THRESHOLD` (suggest
   `HOT_THRESHOLD = 3` or a derived per-category floor; see "non-goal" below
   on per-slug thresholds — pick a global one to stay in scope).
2. **Quiet but reachable** — categories with `1 <= nowCount < HOT_THRESHOLD`,
   collapsed under a `<details>` "Show 4 quiet categories" expander. Same
   card layout, smaller heading.

This addresses the "audit coverage" job-to-be-done without burying the
urgency story under low-volume noise. The reviewer scenario — "any security
this week?" — answers itself from a glance at the expander row count and
opens to the card on click.

### 3.3 Time window: keep 72h

Don't tie the panel to the user's time chip. Two reasons:

1. **Different signal.** The chip controls historical-context aggregations
   (KPI cards, trend chart, priority matrix). The realtime panel answers
   "what's hot *right now*" and is always 72h by design. Coupling them would
   change the urgency ranking when a user clicks "30d" — that's a different
   product.
2. **Cron-cadence math.** 72h ≈ 12 scrape ticks at `0 */6 * * *`. Shrinking
   the window collapses the prior-window comparison; growing it dilutes
   recency decay. There's no data-driven reason to move it as part of this
   change.

If a future PR wants to change 72h → something else, it should be a separate
calibration question with its own eye-test (see "non-goals").

### 3.4 Category filter interaction (`globalCategory`)

Two fixes flow naturally from §3.1:

1. `computeHeroInsight` no longer returns `null` for a filter slug that has
   any observation in the 72h window — the upstream array now contains every
   active slug. The user always gets *something* back when they pick a topic
   they know has data.
2. Pipe `globalCategory` into `CategoryIssuesGrid` so the grid honours the
   chip: when a topic is selected, render that single category's card
   (full-width) plus the Quiet subgroup. This is one prop and ~3 lines of
   filtering.

If `globalCategory` is `"all"` (default), behaviour is the §3.2 grid.

### 3.5 Empty-bucket handling

A category with **zero** observations in the 72h window is invisible by
design (the `nowCount > 0` filter on `realtime.ts:134`). For the audit job,
that's still a gap — the reviewer cannot tell from the panel whether
`security: 0` means "no incidents" or "classifier broken".

Two options, in increasing scope:

- **(a) Same panel:** loosen the filter to `nowCount > 0 || previousCount > 0`
  so a category that *had* signal in the prior 72h still appears (with
  `momentum` negative) and the absence is legible.
- **(b) Separate panel:** add a small "Coverage" footer below the grid that
  enumerates all 11 slugs and notes which had zero observations in the
  window. Doesn't bloat the urgency ranking; satisfies the auditor.

Recommend (a) for this PR, file (b) as a follow-up if the auditor still wants
it after seeing (a).

## 4. Migration plan

Files to touch (all already in this branch's scope):

1. `lib/analytics/realtime.ts:171` — remove `.slice(0, 6)`. Optionally
   loosen line 134 filter per §3.5(a).
2. `components/dashboard/category-issues-grid.tsx:190` — remove the local
   `.slice(0, 6)`; introduce `HOT_THRESHOLD` partition; add `<details>`
   block for Quiet subgroup; thread `globalCategory` from caller.
3. `app/page.tsx:953-957` — pass `categoryFilter={globalCategory}` to
   `<CategoryIssuesGrid>`.
4. `components/dashboard/realtime-insights.tsx` — copy update only ("…the
   last 72 hours" stays accurate; "more topics" wording can be tightened to
   "all topics with activity in the last 72h").
5. `docs/SCORING.md:387` — replace "The top 6 categories" with "All
   categories with `nowCount > 0`, ranked by `urgencyScore` desc". Note the
   removed cap and link this proposal.
6. `docs/ARCHITECTURE.md` §6.2 — add a one-line note that the panel returns
   all active categories and the UI partitions hot vs quiet.

No data-layer migration. No version bumps in `algorithm-versions.ts` —
urgency formula is unchanged.

## 5. Tests to add

In `tests/scoring-pipeline.test.ts` (already imports
`computeRealtimeInsights`):

1. **Coverage invariant** — given a fixture with one observation in each of
   the 11 slugs in the last 72h, `computeRealtimeInsights` returns 11 rows.
   Today this fails (returns 6).
2. **Lead-story stability** — the urgency-#1 slug from the capped result
   equals `result[0].category.slug` from the uncapped result for the same
   input. Guards against re-introducing a cap that breaks the lead/grid
   split contract.
3. **Empty-bucket filter** — a category with zero observations in either
   window is excluded; a category with `nowCount = 0, previousCount > 0` is
   included only if §3.5(a) is implemented (this test pins whichever option
   ships).
4. **Category filter reachability** (integration-style — fine to assert
   against the hero composer): `computeHeroInsight(insights, "security")`
   returns non-null whenever the security slug has any observation in the
   72h window. Today this fails when security is below the urgency cutoff.

A snapshot test on the API response shape (`realtimeInsights[]`) would also
catch silent regressions if anyone re-adds a cap, but is optional.

---

## Hypotheses — verdict

- **H1 (sidebar→full-width layout obsolescence):** plausible but not
  supported by git evidence. The cap was never tied to a layout decision in
  any commit message or doc. Either way: the recommendation in §3 makes the
  layout argument moot.
- **H2 (72h is calibrated to scrape cron):** supported circumstantially
  (12 ticks/window, decoupled from chip per stats route). Keep 72h.
- **H3 (split into separate surfaces):** adopted as the recommendation —
  same array, two visual tiers, no API split needed.
- **H4 (low-volume rising buckets get capped out):** confirmed by the
  2026-04-28 data — `model-quality`, `security`, `api`, `documentation` all
  fit this pattern. §3 fixes it without per-slug thresholds (those stay
  out-of-scope per the brief).

## Out-of-scope (re-stated for the follow-up tracker)

- Don't re-tune `urgencyScore` weights.
- Don't move 72h.
- Don't add per-slug threshold floors inside `computeRealtimeInsights`.
- Don't touch v6 classifier work, Layer 0 Topic phrases, or LLM tiebreaker.
