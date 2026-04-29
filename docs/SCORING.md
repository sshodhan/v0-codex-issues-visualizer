# Scoring Pipeline Reference

_Last updated: 2026-04-20 on branch `claude/review-pr-11-SPlkP` (after PR #11 +
follow-up commits `3b6637f`, `1d91c98`, rebased onto `main`)._

This is the canonical description of how a scraped issue becomes a stored
`sentiment`, `impact_score`, and ranked `urgencyScore`. Read this file before
changing any scoring code or any consumer of `impact_score` / `urgencyScore` /
`negativeRatio`.

**What changed in v2** (`scripts/011_algorithm_v2_bump.sql`, driven by the
top-20-by-impact eye test):

- **impact v2** — source-authority multiplier (§3). First-party GitHub issues
  outrank news/announcement channels at identical engagement.
- **sentiment v2** — complaint-marker lexicon expansion + `does not work` /
  `keeps <V-ing>` multi-word patterns (§2).
- **category v2** — broader phrase lists (Bug `issue`/`unable to`/`can't`/
  `fails`; Documentation `review`/`hands-on`/`walkthrough`; Integration
  `github auth`/`open-source llms`/`integrate`/`vs code`; Feature Request
  `support for`/`when will`) and the Other-fallback threshold lowered from 2
  to 1 so a single phrase hit wins.

**What changed in v3** (`scripts/023_add_model_quality_category.sql`, driven by
the eye-test row "Make gpt-5.5 not get distracted by excessive Frontend
guidance in system prompt" mis-bucketing into Pricing):

- **category v3** — adds a `model-quality` slot disjoint from `bug` for posts
  about model behavior (hallucinations, instruction-following, system-prompt
  distractions, output quality). Patterns include `hallucinat*`,
  `model quality`, `instruction following`, `ignores instructions`,
  `output quality`, `wrong answer`, `system prompt`, `distracted`,
  `off-topic`, `context window`. Also tightens Pricing: drops bare `plan`
  (weight 1, wholeWord) which kept dragging non-pricing posts in on a
  single match, and adds multi-word tier phrases (`free plan`, `pro plan`,
  `team plan`, `paid plan`, `enterprise plan`, `monthly fee`, `per token`,
  `per month`) so paid-tier discussion still classifies cleanly.

**What changed in v4** (`scripts/024_topic_classifier_v4_bump.sql`):

- **category v4** — expanded `CATEGORY_PATTERNS` for coding-agent specific
  reports: MCP / tool invocation / file-edit tooling phrases pulled into
  Integration; `quota`/`usage limit`/`5-hour limit` strengthen Pricing;
  `loop`/`looping`/`repetitive thinking` phrases land in Model Quality;
  diff/approval/loading UX phrasing pulled into UX/UI. Also reweights
  several over-broad terms.

**What changed in v5** (`scripts/025_topic_classifier_v5_bump.sql` +
`scripts/026_category_assignments_evidence.sql`, driven by the production
diagnostic finding `model-quality` at zero observations because long bug
bodies were overwhelming title-level model-quality cues):

- **category v5 — structural refactor, not phrase tuning.** The
  `CATEGORY_PATTERNS` phrase table is unchanged from v4; only the scoring
  architecture changes:
  - **Title/body split.** `categorizeIssue(title, body, categories)` scores
    each segment separately. Title hits are multiplied by 4 before
    summing into the per-slug score. Headlines are short, high-signal,
    and editor-curated; bodies are long and dilute the score with
    incidental terminology. Single title hit at weight 2 ≥ eight body
    hits at weight 1.
  - **Template prefix stripping.** `[BUG]`, `[FEATURE]`, `[FEAT]`,
    `[REQUEST]`, `[QUESTION]`, `[DOCS]`, `[RFC]` are stripped from the
    title before matching so the bracket tag does not consume scoring
    budget. The stripped prefix is preserved in `evidence.input` for
    audit.
  - **Per-slug threshold mechanism.** `SLUG_THRESHOLD` is wired up but
    intentionally left empty in v5 — the default floor of 2 applies to
    all slugs. Threshold tuning is deferred until the backfill evidence
    column shows concrete false-positive patterns for specific slugs.
  - **Structured evidence emission.** `categorizeIssue` returns
    `TopicResult { categoryId, slug, confidenceProxy, evidence }`.
    `confidenceProxy` is a deterministic score-margin ratio (`margin /
    (winner + runnerUp)`, clamped to [0,1]) — not a calibrated model
    probability. The full `evidence` JSONB (see shape below) is persisted
    into `category_assignments.evidence` (new column in `scripts/026`) so
    admin debugging can answer "why did this row classify as X?" with a
    single SQL query.
  - **Regression guard.** `tests/fixtures/topic-golden-set.jsonl` is a
    35-row labelled corpus covering all 11 topic slugs, seeded from
    misclassified production posts surfaced via diagnostic SQL.
    `tests/topic-classifier-golden-set.test.ts` enforces per-row
    precision + ≥90% accuracy floor + v5 structural invariants.
    `scripts/eval-topic-patterns.ts` prints precision/recall/F1 per slug
    in <1s with no DB (`npx tsx scripts/eval-topic-patterns.ts --verbose`).

**v6 (2026-04) — phrase maintenance.** Targeted phrase additions in
`CATEGORY_PATTERNS` for clusters surfaced by the v5 low-margin / manual
review: `developerInstructions` camelCase, merge/branch-conflict
vocabulary, progress-log visibility, `higher limits` / `priority
processing`, `model does not appear` (bounded), `workspace-write` /
`bubblewrap` sandbox + `device passthrough`, ANSI escape injection
(bounded phrases only — no bare `code injection` or `ansi escape`),
`additionalContext` / `PreToolUse` intent distinctions (entity-vs-
mechanism — see the rule below) with `bypass the approval prompt` at
w5 to outscore ux-ui `approval prompt` w4. Removed weak `how to`
documentation phrase — questions are not docs-complaint language. No
scoring-algorithm or threshold changes; `SLUG_THRESHOLD` stays `{}`.
No LLM tiebreaker. No Layer A/B/C changes. Migration:
`scripts/027_topic_classifier_v6_bump.sql`.

**`additionalContext` classification rule (the v6 anti-whack-a-mole
guardrail).** `additionalContext` is an entity, not an intent. **Do
not add bare `additionalcontext` as a Topic phrase.** Topic should
come from the surrounding mechanism:

- support/add `additionalContext` → `feature-request`
- ignored/not used `additionalContext` → `model-quality`
- missing/not passed `additionalContext` in hook payload → `integration`
- crashes/fails with `additionalContext` → `bug`
- `additionalContext` docs unclear / not documented → `documentation`

The golden set carries one contrast row per slug (rows 49–51 — the
three v6 contrast rows for model-quality / integration / bug — plus
row 42, the pre-existing `Support additionalContext in PreToolUse
hooks…` feature-request row) so a future broad `additionalcontext`
phrase cannot silently collapse all four interpretations into one
Topic. Same reasoning generalises to
other entity-only nouns the classifier might be tempted to over-fit on
(e.g. `sandbox`, `pretooluse`, `additionalContext`'s sibling fields):
add the bounded mechanism phrase, not the entity.

**v6 known limitations.**

- **`The model "codex-mini-latest" does not appear`** is *not* fixed in
  v6. The literal-substring matcher cannot safely express
  "model … does not appear" with a model-name token interrupting the
  phrase, and broad `does not appear` is deliberately rejected as too
  cross-slug (UX/UI titles also use "menu does not appear", "icon does
  not appear"). Re-evaluate if a token-skip matcher is added.
- **`would be great`** is *not* added as a feature-request phrase. It
  is too broad without stronger feature-request context — would
  over-fire on negative reviews and general commentary. The existing
  `it would be great` w2 already covers the high-precision case.

**Post-v6 phrase-change policy.** Future `CATEGORY_PATTERNS` changes
require, in the same PR: (1) a golden-set row in
`tests/fixtures/topic-golden-set.jsonl` covering the production miss
the change addresses; (2) before/after `npx tsx
scripts/eval-topic-patterns.ts --verbose` output pasted into the PR
description; (3) an evidence trace from `categorizeIssue` showing the
new phrase fires on the target row and does not regress a control row
from a competing slug; (4) a one-line justification of why the fix
belongs in Layer 0 (deterministic Topic) rather than Layer A (semantic
clustering) or Layer C (LLM taxonomy); (5) confirmation the phrase is
mechanism-bound and not entity-only — bare nouns like
`additionalcontext` / `sandbox` / `ansi escape` / `support` are
rejected; bounded forms like `additionalcontext ignored` /
`workspace-write sandbox` / `ansi escape code injection` /
`support additionalcontext` are accepted. Phrase additions without
all five are out-of-scope for Layer 0.

`evidence` shape stored in `category_assignments.evidence`:

```jsonc
{
  "algorithm_version": "v6",
  "classifier_type": "regex_topic",
  "input": {
    "title_present": true,
    "body_present": true,
    "template_prefix": "[BUG]",   // null if no prefix was stripped
    "template_stripped": true
  },
  "scoring": {
    "title_multiplier": 4,
    "body_multiplier": 1,
    "default_threshold": 2,
    "slug_thresholds": {},         // empty in v5; per-slug overrides added later
    "scores": { "model-quality": 16, "bug": 4 },
    "winner": "model-quality",
    "runner_up": "bug",
    "margin": 12,
    "threshold": 2,
    "confidence_proxy": 0.6        // margin / (winner + runnerUp)
  },
  "matched_phrases": [
    {
      "slug": "model-quality",
      "phrase": "hallucinates",
      "pattern_weight": 4,         // weight in CATEGORY_PATTERNS
      "effective_weight": 16,      // pattern_weight × title_multiplier
      "location": "title",
      "raw_hits": 1,
      "weighted_score": 16,
      "whole_word": false
    }
  ]
}
```

Two-tier `category_id` boundary:
- **Scrapers** write `?.categoryId` onto the raw `observations` row as a
  convenience initial classification. No evidence is stored at ingest.
- **Canonical assignments** live in `category_assignments` with full v5
  evidence, written by the derivation/backfill path via `recordCategory()`
  in `lib/storage/derivations.ts`. Dashboard reads join through
  `mv_observation_current` which picks up `category_assignments` rows.

v1–v4 derivation rows remain in `sentiment_scores` / `category_assignments` /
`impact_scores` for replay comparison; the MV picks the newest per-observation
row via `distinct on (observation_id) order by computed_at desc`.

Related files:

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

**Current version: v2** (complaint-marker lexicon; eye-test Pattern B). v1
kept only explicit valence adjectives (`awful`, `frustrating`, …); v2 adds
polarity verbs/adjectives of distress: `unable`, `stuck`, `missing`,
`can't`, `cannot`, `won't`, `refuses`, `buggy`, `clunky`, `painful`.
Topic/status words (`bug`, `error`, `issue`, `problem`, `crash`, `fail`,
`regression`, `broken`, `fails`, `failed`) remain OUT of the polarity
lexicon — they feed `keyword_presence` only, via
`NEGATIVE_KEYWORD_PATTERNS`. This separation (the P0-2 split) is why v2's
`broken`/`fails`/`failed` aren't double-counted: they were already in the
status-word regex set. `analyzeSentiment` also normalizes U+2019 (curly
apostrophe) to ASCII before tokenizing so `can't`/`doesn't`/`won't` match
on realistic web text. v1 derivation rows stay in `sentiment_scores` for
replay.

Two new multi-word patterns in `analyzeSentiment` (shared.ts), alongside
the existing `doesn't work` / `not working`:

- `does not work`
- `keeps <V-ing>` — narrow pattern catching `keeps (prompting|opening|
  asking|showing|failing|crashing|happening|popping)` without over-triggering
  on neutral uses of `keeps`.

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

**Current version: v2** (source-authority weighting; eye-test Pattern A).
v1 rows remain in `impact_scores` for replay; see §7.4 of
`docs/ARCHITECTURE.md` and `scripts/011_algorithm_v2_bump.sql` for the
append-only contract.

```
engagementScore = min( log10(max(upvotes,1) + max(comments,1)*2) * 2, 8 )
sentimentBoost  = 1.5 if sentiment === "negative" else 1.0
authority       = SOURCE_AUTHORITY[sourceSlug] ?? 1.0         -- v2 addition
impact_score    = min( round(engagementScore * sentimentBoost * authority), 10 )  ∈ [1,10]
```

Source-authority multiplier (v2):

| sourceSlug             | multiplier | rationale                                         |
|------------------------|-----------:|---------------------------------------------------|
| `github`               | 1.8×       | First-party openai/codex issues — triage-actionable |
| `github-discussions`   | 1.4×       | First-party feedback channel, slightly less actionable |
| `stackoverflow`        | 1.0×       | Baseline — task-specific questions                |
| `openai-community`     | 1.0×       | Baseline — first-party forum                      |
| `reddit`               | 0.7×       | Community discussion / announcement               |
| `hackernews`           | 0.7×       | News / announcement                               |
| (omitted / unknown)    | 1.0×       | Back-compat default for 3-arg callers and future sources |

The weights encode the observation that a first-party bug report is
inherently more actionable than a 500-upvote announcement — the v1 formula
was blind to this distinction, so the Pattern A anchor case (the open
`openai/codex` issue that ranked #11 at impact 3) rose appropriately in v2.

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

All categories with activity in the now-window or the prior 72h window are
returned, sorted by `urgencyScore` desc, each with up to 3 sample issues
sorted by `impact_score` desc. The dashboard partitions the result into
"hot" (`nowCount >= HOT_THRESHOLD`) and a collapsed "quiet" subgroup so the
urgency story stays scannable while every active topic remains reachable;
see `docs/reviews/hot-themes-coverage-proposal.md` for the rationale.
Categories that appear only in the prior window are returned with
`avgImpact = 0` and `negativeRatio = 0` — display fields are zeroed rather
than NaN, and `urgencyScore` ranks below every active bucket.

Notes:

- `negativeRatio` is computed and returned but **not** weighted into
  `urgencyScore`. It is intentionally a display signal only; sentiment's
  contribution to urgency now lives inside `impact_score` via
  `calculateImpactScore`'s 1.5× boost.
- The realtime card UI (`components/dashboard/realtime-insights.tsx:39`) now
  reads "(volume + momentum + impact + source diversity)", matching the
  four-term formula above. (Previously advertised "negative sentiment"; fixed
  per N-1 in `docs/BUGS.md`.)

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
| `sentiment`        | `analyzeSentiment`                 | `sentiment_scores.label`          | KPI cards, trend chart, priority matrix color, urgency `negativeRatio`, competitive net sentiment |
| `sentiment_score`  | `analyzeSentiment`                 | `sentiment_scores.score`          | Issues table sort option |
| `keyword_presence` | `analyzeSentiment`                 | `sentiment_scores.keyword_presence` + `bug_fingerprints.keyword_presence` | SignalLayers panel, potential triage gate |
| `impact_score`     | `calculateImpactScore`             | `impact_scores.score`             | Priority matrix Y-axis, issues table sort, urgency `avgImpact`, top-sample ranking |
| `urgencyScore`     | `computeRealtimeInsights`          | computed per request, not stored  | Realtime insights card |
| `negativeRatio`    | `computeRealtimeInsights`          | computed per request, not stored  | Realtime insights card (display) |
| `error_code` / `top_stack_frame` / `top_stack_frame_hash` / `cli_version` / `os` / `shell` / `editor` / `model_id` / `repro_markers` | `extractBugFingerprint` (`lib/scrapers/bug-fingerprint.ts`) | `bug_fingerprints` (algorithm_version = "v1") | SignalLayers panel, priority-matrix tooltip roll-ups, issues-table chips, compound cluster-key label |
| `cluster_key_compound` | `buildCompoundClusterKey(title, fingerprint)` at ingest (sole writer). `computeCompoundKey(supabase, observation_id)` is the read-time helper used by the on-demand classify GET/POST routes — one derivation site for writes, one for reads. | `bug_fingerprints.cluster_key_compound` | SignalLayers "Cluster key" line + `compound_key` drill-down filter (outcome A). Still display/audit; physical cluster membership remains with the semantic pass in `lib/storage/semantic-clusters.ts`. |
| `actionability` | `computeActionability` in `lib/analytics/actionability.ts` | Computed per request in `/api/stats`; not stored | Priority Matrix ranking axis (see §10.1) |
| Fingerprint surge `(error_code, now_count, prev_count, delta, sources)` | `fingerprint_surges(window_hours)` SQL function against `mv_fingerprint_daily` (migration 014) | Not stored | `FingerprintSurgeCard` on the dashboard, wired to the `compound_key` drill-down. |
| `llm_subcategory` / `llm_primary_tag` / other classifier fields | `classifyReport` (`lib/classification/pipeline.ts`) | `classifications` (joined into `mv_observation_current` at MV refresh) | SignalLayers LLM layer, priority-matrix tooltip subcategory counts, issues-table subcategory chip |


## 8. Dashboard interpretation contract

When turning analytics into dashboard copy, follow this interpretation contract:

### API + UX contract (compound sub-cluster filter)

- **API:** `GET /api/issues` supports `compound_key` alongside `days`, `source`, and `sentiment`.
- **Data semantics:** this filter is applied against `mv_observation_current.cluster_key_compound`.
- **UX behavior:** selecting error-code chips/buttons in the Issues Table or the Priority Matrix tooltip applies `compound_key`; when active, a dismissible chip is shown in the Issues Table filter bar.
- **Scope clarification:** this is a read-time sub-cluster filter only; it does **not** alter semantic cluster membership.

- `frequency_count` is **not** a standalone priority narrative. It is a volume
  descriptor and can overstate urgency if repeated low-impact duplicates dominate
  a cluster.
- Priority statements must combine **category context + sentiment composition +
  impact**. Frequency alone is insufficient for ranking action.
- Any urgency claim must include top examples as evidence (the surfaced sample
  issues are mandatory support, not optional decoration).

Canonical UI-copy prioritization signal (approximate):

```
risk_signal = negative_share × avg_impact × momentum
```

Where:

- `negative_share` is the category-level negative sentiment ratio in the active
  window,
- `avg_impact` is the mean `impact_score` for that category/window,
- `momentum` is directional change vs prior window (often shown as `now - prior`;
  apply product-specific handling when momentum is negative).

Use this signal as copy guidance rather than a strict replacement for
`urgencyScore`.

Do/Don’t examples:

- **Do:** “Auth issues are 78% negative and rising +12 vs prior window.”
- **Don’t:** “Auth has 42 issues.”

## 9. Known limitations (summary)

1. `keyword_presence` is now persisted on both `sentiment_scores` and `bug_fingerprints` and surfaced in the SignalLayers panel, but no analytics (urgency, impact) consume it yet — it's an advisory chip only.
2. Valence words use substring (not whole-word) matching.
3. Engagement inputs to `impact_score` are unit-mismatched across sources.
4. Stored `impact_score` is permanently sentiment-inflated.
5. `computeCompetitiveMentions` attributes sentiment to every co-mentioned
   competitor (see **P0-4**).
6. Bug-fingerprint extraction is regex-only and tuned for Codex-style reports. Extraction hit rate on forum bodies (Reddit / HN / SO) is expected to be modest — `error_code` around 20–30%, `top_stack_frame` around 8–15% — so the SignalLayers panel falls back to env tokens (`os`, `shell`, `editor`, `model_id`) and the LLM layer for most rows. Monitor the dry-run report from `scripts/013_backfill_fingerprints.ts` for actual rates.

## 10. Bug-fingerprint contract (algorithm v1)

- **Purpose**: extract concrete differentiators from title + body so two
  similar-sounding reports with different root causes are visibly distinct
  on the dashboard, without waiting for the LLM classifier.
- **Scope**: deterministic regex only. The LLM classifier's output is a
  *separate* layer (`classifications`) and is never merged into the
  fingerprint row or the compound cluster-key label.
- **Compound cluster-key label**: `title:<h>|err:<code>|frame:<fh>` —
  pure function of title + regex fingerprint. Persisted on
  `bug_fingerprints.cluster_key_compound` for audit. Physical cluster
  membership is owned by the semantic-clustering pass (embeddings +
  title-hash fallback) in `lib/storage/semantic-clusters.ts`; the label
  is display/audit only.
- **False-positive guards** (closed during the senior-reviewer pass):
  - HTTP status requires an explicit `http` / `status` / `response`
    prefix so `"waited 500ms"` is not tagged `HTTP_500`.
  - Exit codes require `exit code N` / `exited with N` / `exit status N`
    so `"exited 12 minutes ago"` is not tagged `EXIT_12`.
  - Python exception names require a nearby `Traceback` / `File "..."`
    context so prose mentions of `ConnectionError` don't shadow a more
    specific HTTP code in the same body.
  - Stack-frame hash drops the `:line` suffix so a one-line shift
    between Codex releases doesn't fragment an otherwise-identical
    signal; the line number is retained in the display string only.

### 10.1 Priority Matrix actionability contract (scoring compatibility)

Priority Matrix ranking uses an **actionability** score (not raw frequency and
not the legacy `priorityScore` ordering). The canonical formula is:

```
actionability =
  0.55*(impact/10)
+ 0.20*min(freq/10,1)
+ 0.10*(error_code?1:0)
+ 0.08*min(repro_markers/3,1)
+ 0.07*min(max(source_diversity-1,0)/3,1)
```

Where each term is normalized into `[0,1]` before weighting:

- `impact`: cluster/category impact signal on a 1–10 scale (typically derived
  from `impact_score` aggregates). Normalize with `impact/10`.
- `freq`: frequency count in the active window. Normalize and clamp with
  `min(freq/10,1)` so values above 10 do not overweight volume.
- `error_code`: binary presence signal from bug-fingerprint extraction
  (`error_code` exists → `1`, missing → `0`).
- `repro_markers`: count of reproduction cues from bug-fingerprint extraction.
  Normalize and clamp with `min(repro_markers/3,1)`.
- `source_diversity`: number of distinct sources represented in the grouped
  reports. Convert to a non-baseline bonus via `max(source_diversity-1,0)`,
  then normalize/clamp with `/3` and `min(...,1)`.

Normalization / clamping contract:

- Inputs that are missing or null are treated as `0` for their term.
- Each normalized sub-score is clamped to `[0,1]` exactly as shown above.
- Final `actionability` is the weighted sum of those normalized terms; higher
  means more actionable for triage ordering.

Backward-compatibility contract:

- `priorityScore` remains in payloads for backward compatibility with existing
  consumers.
- **Ordering in the Priority Matrix must use `actionability`** as the primary
  sort key (descending). `priorityScore` must not be presented as the ranking
  authority in new UI copy.

Tooltip copy guidance:

- Use “**actionability**” language (for example, “Actionability score” and
  “Actionability breakdown”), not “priority score”.
- Break down contributions by dimension: impact, frequency cap, error-code
  presence, repro markers, and source diversity bonus.
- Include a short explanatory note that `repro_markers` directly contributes to
  ranking (8% weight, capped), so this signal is not dead/advisory-only data.

### 10.2 Priority Matrix lane aggregation

The Priority Matrix groups per-cluster canonical rows into **category lanes**
for display. Within a lane, lane-level `actionability` is the **mean of the
per-row actionability scores** (not a re-computation from aggregate inputs).
This keeps the scoring formula in one place (`lib/analytics/actionability.ts`)
and makes the lane's rank a direct function of the rows it contains.

Practical consequence: a lane with one 0.95-actionability row outranks a lane
with five 0.70-actionability rows (mean 0.95 vs 0.70). This matches the
dashboard doctrine that one high-actionability cluster is more promote-able
than five mid-actionability clusters — volume already feeds `frequency` in
the per-row score. Ties on mean actionability fall back to the legacy
`priorityScore` (65% impact + 35% frequency) so the visual regression vs
pre-PR behavior on lanes without fingerprint signal is minimal.

## 11. Stage 5 — Topic Review Loop (topic_review_events table, scripts/031_topic_review_events.sql)

**What this is.** Stage 5 capture surface for **Stage 1** (the deterministic regex/topic classifier) per the 5-stage classification improvement pipeline (PR #162):

1. **Stage 1** — Regex / deterministic topic signals (`CATEGORY_PATTERNS` in `lib/scrapers/shared.ts`, persisted into `category_assignments` with structured evidence per scripts/026).
2. **Stage 2** — Embeddings.
3. **Stage 3** — Clustering.
4. **Stage 4** — LLM classification + family naming with deterministic fallback.
5. **Stage 5** — Human-in-the-loop improvement: reviewer feedback that informs future Stage 1 regex / golden-set / taxonomy edits.

This file documents Stage 5 *for Stage 1*. The sibling Stage-5 surface for Stage-4 LLM output is `classification_reviews` (see scripts/030 / PR #163). Both are append-only learning signals; they do not mutate the classifier they review.

### 11.1 Key principles

1. **No classifier mutations.** Review events never change `CATEGORY_PATTERNS` phrases, threshold overrides, or LLM tiebreaker logic. The Stage-1 baseline deterministic assignment in `category_assignments` is preserved verbatim and remains auditable forever.
2. **Append-only.** Reviewers can flag the same observation multiple times under different `reason_code` values. Rows in `topic_review_events` are never updated or deleted. Status transitions (new → candidate → accepted/rejected/exported/resolved) are reserved for a future admin workflow that will append new event rows rather than mutate existing ones.
3. **Manual overrides are optional.** A reviewer can record a structured learning event ("This belongs to Stage 3 clustering, not Stage 1 topic") without applying a manual override. Conversely, a "correct this" manual override is still wrapped in a structured event so future automation can learn from it.
4. **Manual overrides are append-only too.** A manual override appends a new `category_assignments` row with `algorithm_version='manual'` alongside the existing deterministic row. The partial unique index lets manual overrides repeat per observation; the original deterministic verdict is preserved verbatim under `evidence.overridden_assignment`.
5. **Manual override is a read-time correction, not a permanent override.** `mv_observation_current`'s existing `latest_category` CTE picks `max(computed_at)`, so the freshly-inserted manual row beats every existing deterministic row *immediately*. A *future* full-corpus Stage-1 backfill (rare; only on algorithm-version bumps like v6 → v7) writes a new deterministic row with a fresher `computed_at` and would supersede the override on the dashboard until the reviewer re-records it. The override row itself is preserved permanently in `category_assignments` and is always visible in the Trace panel's Manual override history alert (with `effective` / `superseded` badges per row), independent of which row is currently driving the dashboard. The Trace panel and the post-submit success state both surface this contract to reviewers in plain language. See §11.5 for the full ordering contract, the V1 path-B rationale, and the test that captures both branches.

### 11.2 Vocabulary: stage names, not legacy layer names

The `topic_review_events` schema uses the 5-stage names from PR #162 in its `reason_code` and `suggested_layer` value lists. The DB column is still named `suggested_layer` for historical reasons (the column is unchanged from this PR's first cut to keep the migration small) — but the values it carries are stage-named:

| `suggested_layer` value | Stage |
|---|---|
| `regex_topic` | Stage 1 — regex / deterministic topic signals |
| `embedding` | Stage 2 — embeddings |
| `clustering` | Stage 3 — semantic clustering |
| `llm_classification_family` | Stage 4 — LLM classification + family naming |
| `human_review_workflow` | Stage 5 — review workflow (process / triage / backlog problem) |
| `data_quality` | upstream evidence problem (raw observation, capture, ingest) |
| `unknown` | reviewer cannot localise the root cause |

`reason_code` values that previously referenced layers were renamed in lockstep:

| Old value | New value |
|---|---|
| `wrong_layer0_topic` | `wrong_regex_topic` |
| `belongs_to_layer_a_cluster_issue` | `belongs_to_clustering` |
| `belongs_to_layer_c_llm_taxonomy` | `belongs_to_llm_classification_family` |

Same for `suggested_action`:

| Old value | New value |
|---|---|
| `consider_layer_a_split_review` | `consider_clustering_split_review` |
| `consider_layer_c_taxonomy_update` | `consider_llm_taxonomy_update` |

The contract test in `tests/topic-review-contract.test.ts` keeps the SQL CHECK constraints and the constants in `lib/admin/topic-review.ts` in lockstep — drift would fail CI.

### 11.3 Schema (scripts/031_topic_review_events.sql)

- `topic_review_events` — append-only event log
  - `observation_id` — which issue was reviewed
  - `original_topic_slug` / `original_category_id` — the Stage-1 deterministic verdict at review time
  - `corrected_topic_slug` / `corrected_category_id` — (optional) what the reviewer determined is correct
  - `reason_code` — structural category of the error (see §11.2)
  - `suggested_layer` — which stage of the pipeline the reviewer thinks should fix this (see §11.2)
  - `suggested_action` — `none`, `manual_override_only`, `add_golden_row`, `consider_phrase_addition` / `_removal` / `_demotion`, `consider_clustering_split_review`, `consider_llm_taxonomy_update`, `known_limitation_no_action`
  - `phrase_candidate` — (optional) a phrase the reviewer thinks should be added or tuned
  - `rationale` — (optional) free-text explanation
  - `golden_set_candidate` — JSONB `{ title, body, expected }` for future golden-set seeding
  - `evidence_snapshot` — the deterministic v5/v6 evidence JSONB at review time, for audit
  - `status` — `new` (default) → `candidate` → `accepted` / `rejected` / `exported` / `resolved`

### 11.4 Manual override evidence shape

Persisted into `category_assignments(algorithm_version='manual').evidence`:

```json
{
  "override": true,
  "override_type": "topic",
  "overridden_assignment": {
    "algorithm_version": "v6",
    "category_id": "uuid",
    "slug": "bug",
    "confidence": 0.85
  },
  "corrected": {
    "category_id": "uuid",
    "slug": "feature-request"
  },
  "reason_code": "phrase_false_positive",
  "suggested_layer": "regex_topic",
  "suggested_action": "add_golden_row",
  "rationale": "...",
  "reviewer": "alice@example.com",
  "reviewed_at": "2026-04-28T10:00:00Z"
}
```

`overridden_assignment` preserves the original deterministic verdict so audits and future automation can always recover what the classifier said before the review. The Stage-1 baseline row in `category_assignments` itself is also untouched — `evidence.overridden_assignment` is a defensive copy, not the source of truth for audit.

### 11.5 Effective topic precedence — manual overrides are READ-TIME CORRECTIONS, not permanent

**This is the headline operator contract for V1. Read it carefully before applying overrides at scale.**

A manual override is a **read-time correction** that wins on the dashboard because the freshest row in `category_assignments` for the observation is the manual row. It is **NOT** a permanent effective-until-explicitly-changed override — a future Stage-1 deterministic backfill can supersede it on read by writing a fresher deterministic row. The override row itself is preserved permanently; only the MV's "pick latest" tie-breaker shifts.

Concretely, the pick logic is the existing `latest_category` CTE in `mv_observation_current` (scripts/018), unchanged by this PR:

```sql
select distinct on (observation_id) ...
from category_assignments
order by observation_id, computed_at desc
```

`record_manual_topic_override` inserts the manual row with `now()` as its `computed_at`, so:

- **Right after a manual override is recorded** the manual row is the most recent for that observation and wins on read.
- **A subsequent Stage-1 deterministic backfill** (admin-driven; rare — happens on a `category` algorithm-version bump like v6 → v7) inserts a new deterministic row with a fresher `computed_at`, which then supersedes the manual override on the dashboard. The manual row itself is **preserved in `category_assignments` and still surfaced by the trace UI** (the trace API returns a `manualOverrideHistory` array of every manual row for the observation, regardless of whether it is currently effective); only the MV's "pick latest" tie-breaker shifts.
- **The reviewer can re-record the override** after a backfill — append a second manual row, which then has the freshest `computed_at` and wins again. This is the workflow for "re-pinning" an override across an algorithm-version bump.
- **Retract an override** by appending another manual row whose corrected slug matches the latest deterministic slug. Never DELETE the original manual row; the retracting row carries its own evidence + reason explaining why the override is being reversed.

#### What the UI tells reviewers

The Trace panel on `/admin?tab=topic-review` always renders a **Manual override history** alert when any manual row exists for the observation, with one of two messages:

- *Currently effective* (an `effective` badge on the most recent manual row): "Note: a future Stage 1 backfill may supersede this on the dashboard until the override is re-recorded; the override row itself is preserved permanently."
- *Currently superseded* (a `superseded` badge on every manual row): "No manual override is currently effective. A deterministic Stage 1 row has superseded the most recent manual override because `mv_observation_current` picks `max(computed_at)`. Re-record the override if the corrected topic should still apply."

After a successful submission with the override checkbox ticked, the success state shows a persistent amber-highlighted box repeating the read-time-correction contract verbatim — reviewers see this on every override they apply.

#### Why this is V1's choice

Making manual rows always win regardless of `computed_at` requires giving them explicit precedence in the CTE:

```sql
order by observation_id,
         (algorithm_version = 'manual') desc,
         computed_at desc
```

That one-line semantic change costs ~360 lines of drop-and-recreate SQL across `mv_observation_current` plus its dependents (`mv_trend_daily`, `mv_cluster_health_current`) — an operator hop with non-trivial blast radius (initial populate after recreate is heavy, and any drift in the recreated MV bodies breaks every dashboard query that reads them). Combined with the fact that:

- Stage-1 algorithm bumps are rare (one per migration like 027 v6 bump),
- The trace UI surfaces the full manual override history regardless of effective status, and
- Re-recording is a one-click admin workflow,

V1 chooses path B (timestamp-based, with explicit visibility) and defers the MV change to a separate, focused follow-up PR if operator feedback shows reviewers actually hit this footgun in practice.

#### Test coverage

`tests/topic-review-precedence.test.ts` locks four branches of the contract: manual-wins-immediately, deterministic-supersedes-after-backfill, re-record-restores, and retract-via-second-override.

### 11.6 Append-only invariants — what stays immutable

Both surfaces are deliberately insert-only from application code:

- **`topic_review_events`** is only ever inserted, via the SECURITY DEFINER `record_topic_review_event` RPC. Application code never issues UPDATE or DELETE against this table. Future status transitions will append new event rows, not mutate existing ones. RLS policies grant `for all` to `service_role` only because the RPC needs INSERT through that role — not because the surface is wider.
- **Manual overrides on `category_assignments`** are appended via `record_manual_topic_override`. The deterministic Stage-1 row is preserved verbatim; `evidence.overridden_assignment` captures the algorithm version / category id / slug / confidence the classifier produced.

### 11.7 Golden-set candidate is export-only

`golden_set_candidate` JSONB on each `topic_review_events` row carries `{ title, body, expected }` — the same shape consumed by `tests/fixtures/topic-golden-set.jsonl`. The admin UI surfaces it as copyable JSONL on the trace panel; that is the only place it ever leaves the database.

The admin loop **does not**:

- write to `tests/fixtures/topic-golden-set.jsonl` or any other fixture file
- modify `CATEGORY_PATTERNS` in `lib/scrapers/shared.ts`
- generate a migration script that bumps the Topic algorithm version
- create a pull request, push to a branch, or call any GitHub API

Promoting a candidate into the golden set is a separate, human-reviewed PR. Same for `phrase_candidate`: the reviewer is *suggesting* a phrase the classifier should learn — the classifier itself is unchanged until a human writes the migration and the PR.

### 11.8 Queue is sampled from recent assignments, not exhaustive

The `/api/admin/topic-review/queue` route scans recent deterministic `category_assignments` rows, dedupes to one per observation, and applies filters. The scan limit is bounded for latency — broaden filters or raise the `limit` query parameter if expected candidates are missing. The Queue is a sampled-recent triage view, not a complete audit export. (For an exhaustive view, query `category_assignments` directly.)

### 11.9 Future automation path

1. **Collect review events** over a period (e.g. one week of production triage).
2. **Group by repeated failure modes** (`reason_code`, `suggested_layer` (a.k.a. stage), `suggested_action`, `phrase_candidate` clusters).
3. **Propose candidates** ("this phrase should be added; here are 12 observations where it would fix the classification").
4. **Create reviewed PRs** — humans review the proposal and update `CATEGORY_PATTERNS` + the golden-set test fixture.
5. **Deploy** the PR; future backfill picks it up as a new algorithm version.

Review events themselves do NOT trigger automatic classifier changes, golden-set updates, or PRs. The automation path is async, human-reviewed, and deliberate.
