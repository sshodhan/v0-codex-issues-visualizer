# Scoring Pipeline Reference

_Last updated: 2026-04-20 on branch `claude/review-pr-11-SPlkP` (after PR #11 +
follow-up commits `3b6637f`, `1d91c98`, rebased onto `main`)._

This is the canonical description of how a scraped issue becomes a stored
`sentiment`, `impact_score`, and ranked `urgencyScore`. Read this file before
changing any scoring code or any consumer of `impact_score` / `urgencyScore` /
`negativeRatio`. Related files:

- `lib/scrapers/shared.ts` — sentiment, keyword presence, impact score.
- `lib/analytics/realtime.ts` — urgency formula.
- `lib/analytics/competitive.ts` — per-competitor sentiment aggregate.
- `app/api/stats/route.ts` — DB reads + invocation of the analytics modules.
- `components/dashboard/realtime-insights.tsx` — displays urgency.

## 1. End-to-end flow

```
provider (reddit | hackernews | github | github-discussions | stackoverflow | openai-community)
   │
   │  text = `${title} ${content}`
   │
   ├─► analyzeSentiment(text)
   │      returns { sentiment, score, keyword_presence }
   │        sentiment         ∈ { "positive" | "negative" | "neutral" }
   │        score             ∈ [-0.99, 0.99]
   │        keyword_presence  ∈ ℕ   (count of bug-topic regex hits)
   │
   ├─► calculateImpactScore(upvotes, comments, sentiment)
   │      returns impact_score ∈ [1, 10]
   │
   └─► issue row written to Supabase `issues`
          columns used: sentiment, sentiment_score, impact_score,
                        upvotes, comments_count, ...
          NOT stored:    keyword_presence   ← returned, never persisted

          ▼
   /api/stats reads a 6-day window, feeds it to:
          computeRealtimeInsights(issues)   → urgencyScore, negativeRatio, …
          computeCompetitiveMentions(issues) → per-competitor sentiment

          ▼
   Dashboard consumes urgencyScore / negativeRatio / avgImpact /
   sourceDiversity / momentum.
```

## 2. Sentiment classification (`analyzeSentiment`)

**Two keyword sets, two different jobs:**

| Set                         | Purpose                                 | Contributes to |
|-----------------------------|-----------------------------------------|----------------|
| `positiveWords`             | Valence (tone) — positive adjectives.   | `sentiment`, `score` |
| `negativeWords`             | Valence (tone) — negative adjectives.   | `sentiment`, `score` |
| `NEGATIVE_KEYWORD_PATTERNS` | Topic (the post _is about_ a bug/error). | `keyword_presence` only |

Before PR #11 these two concepts were merged into `negativeWords`, so every
"Bug: crash in …" post was forced to negative sentiment regardless of tone.
PR #11 separated them. `NEGATIVE_KEYWORD_PATTERNS` now covers tense / plural
variants: `bug(s)`, `error(s)`, `crash/es/ed/ing`, `broken`, `issue(s)`,
`problem(s)`, `regression(s)`, `not working`, `doesn't work`,
`fail/s/ed/ing/ure/ures`.

Algorithm:

```
lowerText = text.toLowerCase()
positiveCount = |{ w ∈ positiveWords : lowerText.includes(w) }|
negativeCount = |{ w ∈ negativeWords : lowerText.includes(w) }|
score         = (positiveCount - negativeCount) / (positiveCount + negativeCount)

sentiment = "positive" if score >  0.2
          = "negative" if score < -0.2
          = "neutral"  otherwise   (including 0/0 → score=0)

keyword_presence = Σ regex-match counts from NEGATIVE_KEYWORD_PATTERNS
```

Known limitations:

- `positiveWords` / `negativeWords` use `.includes(word)` — `"bad"` matches
  `"badge"`, `"worst"` does not have this problem but `"fast"` is counted as
  positive even inside `"breakfast"`. A whole-word switch is trivial; see
  `NEGATIVE_KEYWORD_PATTERNS` for the regex style to adopt.
- Scoring is computed on `title + " " + content`; `keyword_presence` counts
  every hit, so a title like "Bug: bug in bug report" contributes 3 to
  `keyword_presence` even though it describes a single bug.
- Category-phrase overlap: `"broken"` is a `bug`-category signal
  (`CATEGORY_PATTERNS.bug`, weight 2, wholeWord) but is _not_ in
  `negativeWords`. This is intentional — we let the category system
  attribute it. If you re-add it to `negativeWords`, audit the effect on
  bug-category posts first.

## 3. Impact score (`calculateImpactScore`)

```
engagementScore = min( log10(max(upvotes,1) + max(comments,1)*2) * 2, 8 )
sentimentBoost  = 1.5 if sentiment === "negative" else 1.0
impact_score    = min( round(engagementScore * sentimentBoost), 10 )     ∈ [1,10]
```

- Stored in `issues.impact_score` (INT, CHECK between 1 and 10).
- Per PR #11, the sentiment boost stays here (rather than in the urgency
  formula) so it survives across any analytics layer that reads
  `impact_score` directly (priority matrix, issues table, top-3 samples per
  urgency bucket, classifier triage trigger thresholds, etc.).

Known limitations:

- `upvotes` and `comments` are unit-mismatched across providers:
  - Reddit: post `score`, `num_comments`.
  - Hacker News: `points`, `num_comments`.
  - GitHub Issues: `reactions.total_count`, `comments`.
  - GitHub Discussions: `upvoteCount`, `comments.totalCount`.
  - Stack Overflow: question `score`, **`answer_count`** (answers are not
    comments; this slot is misnamed for SO).
  - OpenAI Community (Discourse): `like_count`, `reply_count`.
  There is no normalisation; a 10-like Discourse topic, a 10-point HN post,
  and a 10-reaction GitHub issue all feed `log10(...)` identically.
- The stored `impact_score` is *permanently* sentiment-inflated. A future
  feature that needs a pure engagement score cannot recover it from the DB
  — add a new column or recompute from `upvotes` / `comments_count`.

## 4. Urgency score (`computeRealtimeInsights`)

Operates on a 72-hour "now" window and the preceding 72-hour "previous"
window (the caller in `/api/stats` supplies a 6-day window, which covers
both).

Per category bucket:

```
decayedVolume  = Σ max(0, 1 - ageMs / windowMs)  over issues in "now"
momentum       = nowCount - previousCount
avgImpact      = impactTotal / nowCount
negativeRatio  = negativeCount / nowCount          (display only, 0–100)
sourceDiversity = |{ distinct source.name in "now" }|

urgencyScore =
    decayedVolume       * 1.6
  + max(momentum, 0)    * 1.4
  + avgImpact           * 1.0
  + (sourceDiversity-1) * 0.8
```

The top 6 categories by `urgencyScore` are returned, each with up to 3 sample
issues sorted by `impact_score` desc.

Notes:

- `negativeRatio` is computed and returned but **not** weighted into
  `urgencyScore`. It is intentionally a display signal only; sentiment's
  contribution to urgency now lives inside `impact_score` via
  `calculateImpactScore`'s 1.5× boost.
- The realtime card UI (`components/dashboard/realtime-insights.tsx:39`)
  still advertises "volume + momentum + impact + negative sentiment" as the
  urgency recipe — that copy is stale and should be updated to drop
  "negative sentiment" (tracked as N-1 in `docs/BUGS.md`).

## 5. Competitive sentiment (`computeCompetitiveMentions`)

Groups issues by matched competitor (`COMPETITOR_KEYWORDS`). For each
competitor:

```
netSentiment = Σ (+1 if sentiment="positive", -1 if "negative", 0 otherwise) / totalMentions
```

Known limitation (tracked as **P0-4**, still-open): if a post mentions two
competitors, its sentiment is attributed to both. "Cursor is much better than
Windsurf" currently logs +1 to Cursor _and_ +1 to Windsurf.

## 6. Signal inventory

| Signal             | Computed in                        | Stored in                         | Consumed by |
|--------------------|------------------------------------|-----------------------------------|-------------|
| `sentiment`        | `analyzeSentiment`                 | `issues.sentiment`                | KPI cards, trend chart, priority matrix color, urgency `negativeRatio`, competitive net sentiment |
| `sentiment_score`  | `analyzeSentiment`                 | `issues.sentiment_score`          | Issues table sort option |
| `keyword_presence` | `analyzeSentiment`                 | **not stored**                    | **no consumer** — returned but dropped |
| `impact_score`     | `calculateImpactScore`             | `issues.impact_score`             | Priority matrix Y-axis, issues table sort, urgency `avgImpact`, top-sample ranking |
| `urgencyScore`     | `computeRealtimeInsights`          | computed per request, not stored  | Realtime insights card |
| `negativeRatio`    | `computeRealtimeInsights`          | computed per request, not stored  | Realtime insights card (display) |

## 7. Known limitations (summary)

1. `keyword_presence` is a returned-but-unconsumed signal. Pick one:
   remove from the return type, persist as a column and index it, or wire
   it into `calculateImpactScore` / urgency. Leaving it as-is invites
   future contributors to assume it's already used.
2. Valence words use substring (not whole-word) matching.
3. Engagement inputs to `impact_score` are unit-mismatched across sources.
4. Stored `impact_score` is permanently sentiment-inflated.
5. `computeCompetitiveMentions` attributes sentiment to every co-mentioned
   competitor (see **P0-4**).
6. UI card copy for urgency is stale (see **N-1** in `docs/BUGS.md`).
