# Clustering Design: Semantic + Deterministic Hybrid

## Status
- **Document date:** 2026-04-22
- **Scope:** clustering architecture, ingestion integration, OpenAI-powered semantics, fallback behavior, and operational model.

---

## 1) Problem Statement

The previous clustering model grouped observations by hashing a normalized title (`title:<md5>`). This was deterministic and cheap, but did not reliably group semantically equivalent reports that used different wording.

Examples of misses:
- “Codex login loop after update”
- “Can’t sign in since latest release”

These are often the same issue family but differ lexically.

### Goals
1. Produce **logical clusters** that better match how humans triage related incidents.
2. Preserve **high reliability** and **low operational risk** under model/API failures.
3. Keep clustering append-only and compatible with existing aggregation invariants.
4. Integrate with AI classification so triage clusters are populated continuously.

### Non-goals
- Replace evidence-layer append-only guarantees.
- Introduce hard dependency on OpenAI availability for successful ingestion.

---

## 2) High-Level Architecture

We now run a **hybrid clustering pipeline**:

1. **Semantic-first pass (OpenAI embeddings + graph clustering)**
   - Build or reuse per-observation embeddings.
   - Group observations by cosine similarity threshold and minimum cluster size.
   - Assign semantic cluster keys (`semantic:<md5(ids)>`).
   - Generate cluster labels/rationales via OpenAI.

2. **Deterministic fallback pass (title hash)**
   - For observations that cannot be semantically clustered (or embedding/labeling fails), attach using existing deterministic title hashing.

This design gives the accuracy benefits of semantic grouping without sacrificing ingest throughput and reliability.

---

## 3) Data Flow

### 3.1 Ingestion + derivation
For each scraped issue:
1. Persist observation/revision/engagement/artifact in evidence layer.
2. Persist derivations (sentiment/category/impact).
3. Return classification + semantic candidate metadata for newly seen observations.

After the scrape loop completes, run **one post-loop batched clustering pass**
across all new semantic candidates for the run (semantic first, deterministic
fallback). This prevents the singleton-batch failure mode where `minClusterSize
= 2` would force every observation into fallback if clustering were called
per-item.

### 3.2 Classification queue population
After source scraping completes, the run accumulates classification candidates (new observations only by default) and processes them through shared classification pipeline logic.

This prevents the triage panel from staying empty unless ingestion itself is empty.

---

## 4) Clustering Algorithm Details

### 4.1 Embedding generation
- Embedding model: `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`).
- Input text: compact title+content form from `buildEmbeddingInputText(...)`.
- Embeddings are cached in `observation_embeddings` with algorithm version (`observation_embedding`) to support replay/versioning.

### 4.2 Grouping strategy
- Compute pairwise cosine similarity among embedded observations in the batch.
- Build connected components where similarity >= threshold (default `0.86`).
- Components with size >= `minClusterSize` (default `2`) become semantic groups.
- Remaining observations are marked for deterministic fallback.

### 4.3 Semantic cluster keying
- Key format: `semantic:<digest>` where digest is MD5 over sorted member observation IDs.
- Stable for same membership set.

### 4.4 Labeling

The cluster's `label` is surfaced to users as the **"Family name"**
(clusters render as **"Families"** in user copy — "Top Families"
section, drill-down chips, family-detail page `<h1>`, V3 prioritized-
rails cards, story-tab cluster list, classification-triage chip
strip). It is distinct from per-issue `llm_subcategory` (one string
per cluster vs. one string per classified observation). The
technical noun "Semantic cluster (Layer A)" stays in methodology
surfaces (e.g. the `LayerExplainerRow` in classification-triage). See
`docs/ARCHITECTURE.md` §6.0 for the cross-vocabulary glossary.

#### 4.4.1 Source priority (`semantic_cluster_label` v2)

The labeller writes one of five possible v2 source tags into
`clusters.label_model` (a sixth, the legacy `fallback:title`, only
appears on pre-v2 rows that have not yet been backfilled). All tags
are surfaced as a typed const-object `LABEL_MODEL` in
`lib/storage/cluster-label-fallback.ts`, so a typo at any write site
is a compile error and `grep LABEL_MODEL` enumerates every emission
and read site.

Resolution order, evaluated per cluster:

```
┌─────────────────────────────┐  confidence ≥ 0.7
│ small-model LLM             ├──────────────► accept
│ OPENAI_CLUSTER_LABEL_MODEL  │   `openai:<small-model>`
└──────────────┬──────────────┘
               │ confidence < 0.7
               ▼
┌─────────────────────────────┐  pick higher-confidence of the two
│ large-model LLM (escalate)  ├──────────────► if best ≥ 0.6, accept
│ OPENAI_CLUSTER_LABEL_       │   `openai:<chosen-model>`
│ MODEL_LARGE                 │
└──────────────┬──────────────┘
               │ best LLM confidence < 0.6 OR both calls failed
               ▼
┌─────────────────────────────┐  always returns a label at conf ≥ 0.4
│ deterministic fallback      ├──────────────► write whichever rung fired
│ composeDeterministicLabel() │   `deterministic:topic-and-error` (0.55)
│                             │   `deterministic:topic`           (0.45)
│                             │   `deterministic:error`           (0.45)
│                             │   `deterministic:title`           (0.40)
└─────────────────────────────┘
```

The escalation step mirrors `lib/classification/pipeline.ts:160-192`
exactly (same `0.7` trigger, same env-var convention, same
`processing_events` `attempted` / `escalated` shape). Mirroring is
deliberate so operators carry one mental model across both pipelines.

#### 4.4.2 Deterministic fallback rungs

Implemented in `lib/storage/cluster-label-fallback.ts` as a pure
function — no Supabase, no OpenAI, no React in scope; it is unit-
tested directly via `tests/cluster-label-fallback.test.ts` (10
cases). Inputs come from member-aggregate signals already present in
the three-layer model (no new derivation, no new column):

| Rung | Signals required | Example label | Confidence | `label_model` |
|------|------------------|---------------|------------|---------------|
| 1 | dominant Topic + dominant error code | `Bug cluster · ENOENT` | `0.55` | `deterministic:topic-and-error` |
| 2 | dominant Topic only | `Performance cluster` | `0.45` | `deterministic:topic` |
| 3 | dominant error code only | `EACCES cluster` | `0.45` | `deterministic:error` |
| 4 | titles only (last resort) | `Cluster · <shortest title>` | `0.40` | `deterministic:title` |

- *Dominant* = `mode()` over the cluster's members, ties broken
  lexicographically ascending. Deterministic across runs, matches
  the dominant slug the LLM prompt was told about.
- Topic comes from `category_assignments.category_id` →
  `categories.slug` (the heuristic regex bucket, written every
  ingest by `lib/scrapers/index.ts:165` via `recordCategory`).
- Error code comes from `bug_fingerprints.error_code` (regex
  extractor in `lib/scrapers/bug-fingerprint.ts`, written every
  ingest at `lib/scrapers/index.ts:201` — see migration
  `013_bug_fingerprints.sql`).
- Topic-slug → display name resolved by `topicNameForSlug()`:
  static map for the 10 seed slugs in `scripts/002_*.sql`
  (`Bug`, `Performance`, `Feature Request`, …), title-case
  fallback for slugs added later so unknown topics still degrade
  gracefully.

#### 4.4.3 Confidence calibration

The numbers (`0.4` / `0.45` / `0.55` / `0.6` / `0.7`) are not
calibrated probabilities — `clusters.label_confidence` is a
self-reported score from the labeller. They are picked as
*ranking thresholds* with these invariants:

| Threshold | Meaning | Used where |
|-----------|---------|------------|
| `0.4` | UI show-floor | exported constant `MIN_DISPLAYABLE_LABEL_CONFIDENCE` in `lib/storage/cluster-label-fallback.ts`, imported by `app/page.tsx`, `app/families/[clusterId]/page.tsx`, `components/dashboard/{dashboard-story-view,v3-view,classification-triage}.tsx` |
| `0.4` | Lowest deterministic write | `cluster-label-fallback.ts` `CONFIDENCE_TITLE_ONLY` (defined as `= MIN_DISPLAYABLE_LABEL_CONFIDENCE`, so a single edit moves both) |
| `0.55` | Highest deterministic write | `cluster-label-fallback.ts` `CONFIDENCE_TOPIC_AND_ERROR` |
| `0.6` | LLM accept floor | `semantic-clusters.ts` `LABEL_ACCEPT_BELOW` |
| `0.7` | LLM escalation trigger | `semantic-clusters.ts` `LABEL_ESCALATE_BELOW` — matches `pipeline.ts` |
| `0.8` | "High confidence" badge | `classification-triage.tsx` `LABEL_CONFIDENCE_HIGH_THRESHOLD` — only LLM-confident labels qualify |

**Self-enforcing contract.** Both the UI show-floor and the lowest
deterministic write reference the *same* exported constant
(`MIN_DISPLAYABLE_LABEL_CONFIDENCE`), so a single edit moves both in
lockstep — it is impossible for the labeller to write a value the UI
would suppress. A future engineer adding a new rung at confidence
`0.3` would have to lower the constant, which mechanically lowers the
UI floor at every render site. The contract is also pinned at runtime
by `tests/label-confidence-contract.test.ts`, which fails the build
if any UI file regresses to a hardcoded `0.4` literal next to
`label_confidence`.

The deterministic ceiling (`0.55`) sits below the LLM accept floor
(`0.6`), so a confident LLM label always out-ranks the strongest
deterministic one in any sort that uses `label_confidence`. This
keeps "Top Families by confidence" intuitive without separate
sort keys per source.

#### 4.4.4 Prompt context (passed to the LLM step)

```
Likely Topic for the cluster: <dominant-topic-name>.
Recurring error codes: <up to 3, distinct>.

Issue titles (<N> total, showing up to 8):
1. <title>
2. <title>
…
```

Constraints in prompt copy:
- Label `<= 6 words`, *topic-flavoured even when uncertain*
  (e.g. `Auth Issue Cluster` rather than refusing).
- Confidence `0..1`, lower honestly when titles are heterogeneous;
  do not penalise terse-but-topical labels.
- "Prefer a label grounded in the supplied Topic and recurring
  error code when present."

Caps live as named constants
(`LABEL_PROMPT_TITLE_LIMIT = 8`,
`LABEL_PROMPT_ERROR_CODE_LIMIT = 3`) in
`lib/storage/semantic-clusters.ts:40-41`.

#### 4.4.5 Audit trail

Per-row, on `clusters`:
- `label` — the displayed string.
- `label_rationale` — the labeller's one-sentence justification
  (LLM rationale or deterministic-fallback prose).
- `label_confidence` — see §4.4.3.
- `label_model` — one of five v2 values (§4.4.1) on rows written
  under v2; pre-v2 rows may still carry the legacy `fallback:title`
  stub until the backfill has run (§4.4.7).
- `label_algorithm_version` — `semantic_cluster_label` (currently
  `v2`). Pinned across the runtime registry
  (`lib/storage/algorithm-versions.ts`) and the schema verifier
  manifest (`lib/schema/expected-manifest.ts`) by
  `tests/algorithm-version-manifest-contract.test.ts`, which fails
  the build if either half of that pair is bumped without the other.
- `labeling_updated_at` — last write.

All written via the `set_cluster_label` SECURITY DEFINER RPC
(`scripts/012_semantic_clustering.sql:47`). Row-level audit makes
queries like *"of clusters labelled in the last 7 days, what
fraction needed deterministic fallback?"* answerable directly:

```sql
SELECT label_model, count(*)
FROM clusters
WHERE labeling_updated_at > now() - interval '7 days'
GROUP BY label_model;
```

#### 4.4.6 Observability

Time-series view on top of the row-level audit: every fallback
write emits a structured server log via
`lib/error-tracking/server-logger.ts`:

```jsonc
{
  "component": "cluster-labeling",
  "event": "deterministic_fallback_used",
  "level": "info",
  "data": {
    "cluster_key": "semantic:<digest>",
    "cluster_id": "<uuid>",
    "member_count": <N>,
    "dominant_topic_slug": "bug" | null,
    "distinct_error_codes": ["ENOENT", …],
    "llm_confidence": <number> | null,
    "llm_model": "gpt-5-mini" | null,
    "chosen_model": "deterministic:topic-and-error",
    "chosen_confidence": 0.55
  }
}
```

A spike in `deterministic_fallback_used` rate doesn't break the
pipeline (Reliability principles in §6.1 still hold) — it is the
canary that LLM label quality is degrading before users notice.

#### 4.4.7 Backfill

`scripts/021_backfill_deterministic_labels.ts` is the one-shot
catch-up that follows `semantic_cluster_label` v1 → v2. Pattern
follows `scripts/013_backfill_fingerprints.ts` exactly:

1. Dry-run by default — writes `scripts/tmp/cluster-label-backfill-
   YYYYMMDD.json` with the per-cluster decision matrix and a
   summary tally by `label_model`. No DB writes.
2. `--apply` requires the env var `CLUSTER_LABEL_CONFIRM=yes` —
   refusal exit code `2` otherwise.
3. Selection: clusters where
   `label_confidence < 0.6 OR label_model = LABEL_MODEL.LEGACY_FALLBACK_TITLE
    OR label IS NULL`. The legacy tag is the v1 stub model string
   (`'fallback:title'`); the script references it via the typed
   constant in `cluster-label-fallback.ts` so the migration target
   is grep-discoverable and survives a rename. Idempotent:
   re-running preserves confident LLM labels written between runs.
4. Per cluster: pulls active members from `cluster_members`
   (`detached_at IS NULL`), then their Topic slugs and error codes
   in batched lookups, calls `composeDeterministicLabel(...)`,
   writes via `set_cluster_label` RPC with the appropriate
   `lbl_model` tag.

Run order:

```bash
# 1) Apply v2 pipeline (this PR), then dry-run:
node --experimental-strip-types scripts/021_backfill_deterministic_labels.ts --dry-run

# 2) Review scripts/tmp/cluster-label-backfill-YYYYMMDD.json,
#    confirm the by_model distribution looks reasonable.

# 3) Apply:
CLUSTER_LABEL_CONFIRM=yes \
  node --experimental-strip-types scripts/021_backfill_deterministic_labels.ts --apply
```

#### 4.4.8 UI rendering contract

Producer (`semantic-clusters.ts`, after the labeller runs) guarantees:

> Every cluster row has `label IS NOT NULL` and
> `label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE` after the
> labeller runs.

Consumer (the render sites listed below) guarantees:

> Anything `label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE` is
> shown verbatim. Anything below is impossible (the producer cannot
> emit it). `label IS NULL` is defence-in-depth only — rendered as
> `Cluster #<short-id>` rather than the legacy "Unnamed family"
> placeholder. The `LABEL_CONFIDENCE_HIGH_THRESHOLD = 0.8`
> separately gates the "High confidence" badge so the *quality*
> signal is preserved at a different surface (badge vs name).

The two contracts compose mechanically because they reference the
**same exported constant**. Two thresholds, two non-overlapping
meanings. Render-site list:

| Surface | File | Threshold check |
|---------|------|------------------|
| Top Families card grid | `app/page.tsx` | `cluster.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE` |
| Active-cluster header chip | `app/page.tsx` | `row.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE` |
| Story-tab cluster list | `components/dashboard/dashboard-story-view.tsx` | `r.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE` |
| V3 prioritized-rails card | `components/dashboard/v3-view.tsx` | `cluster.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE` |
| Triage chip strip + detail panel + breadcrumb (3 sites) | `components/dashboard/classification-triage.tsx` | `hasTrustedLabel(...)` (constant `LABEL_CONFIDENCE_SHOW_THRESHOLD = MIN_DISPLAYABLE_LABEL_CONFIDENCE`) |
| Family-detail page `<h1>` | `app/families/[clusterId]/page.tsx` | `data.family.label_confidence >= MIN_DISPLAYABLE_LABEL_CONFIDENCE` |
| Issues-table active-cluster pill | `components/dashboard/issues-table.tsx` | inherits via `activeClusterLabel` prop |

The contract is pinned at three layers of test depth:
- **Per-rung** — `tests/cluster-label-fallback.test.ts` asserts every
  rung emits the canonical `LABEL_MODEL.*` value at confidence ≥
  `MIN_DISPLAYABLE_LABEL_CONFIDENCE`.
- **Producer/consumer** — `tests/label-confidence-contract.test.ts`
  asserts the deterministic-rung emission set equals the
  `LABEL_MODEL` deterministic taxonomy, and walks `app/` and
  `components/dashboard/` to fail the build on any hardcoded `0.4`
  literal next to `label_confidence`.
- **Algorithm version** —
  `tests/algorithm-version-manifest-contract.test.ts` asserts the
  `semantic_cluster_label` value in `CURRENT_VERSIONS` equals the
  one in `EXPECTED_MANIFEST`, so a future bump can't drift the
  schema verifier into a false-positive "unapplied migration"
  warning.

### 4.5 Fallback guarantees
If any of the following occur:
- missing API key,
- embedding request failure,
- label request failure,
- not enough semantically similar neighbors,

then the observation still gets attached through deterministic title hashing (`attachToCluster` with `buildClusterKey`).

### 4.6 Cluster topic metadata (Layer-A explanatory signal)

Layer 0 (the heuristic Topic classifier in `lib/scrapers/shared.ts`)
writes per-observation evidence — `evidence.scoring.{winner,
runner_up, margin, confidence_proxy, scores}` plus
`evidence.matched_phrases[]` — into the JSONB column on
`category_assignments` (scripts/026). Those rows stay
observation-level; nothing about Layer 0 changes here.

> **Trust caveat.** These fields summarise classifier evidence; they
> are not ground-truth labels. Use them to prioritise review and
> improve Family naming, not to assert root cause without inspecting
> representative observations.

`scripts/028_cluster_topic_metadata.sql` adds a *read-only* MV,
`mv_cluster_topic_metadata`, that **aggregates** that evidence onto the
embedding-built clusters. The view filters `category_assignments` by
the Topic version that is `current_effective` in `algorithm_versions`
at refresh time, so v5 → v6 (and future shape-preserving bumps) carry
over without an SQL edit. A bump that *changes* the evidence shape
must rev this view in the same migration. Per cluster the MV emits:

| Column | Meaning |
|--------|---------|
| `observation_count` | Active members (`cluster_members.detached_at IS NULL`). |
| `classified_count` | Subset with a current-version evidence row. |
| `unclassified_count` | Members the classifier hasn't (re-)processed yet (`observation_count − classified_count`). Distinct from `categories.slug = 'other'`, which is a real Topic decision. |
| `classification_coverage_share` | `classified_count / observation_count` (NUMERIC(5,4)). Pair with `mixed_topic_score` to disambiguate "this Family genuinely spans Topics" from "Layer 0 hasn't caught up yet". |
| `topic_distribution` | `JSONB {slug → count}`. Includes an `unclassified` bucket so values sum to `observation_count`. |
| `dominant_topic_slug` | Lex-tiebroken mode of `topic_distribution`, excluding `unclassified` unless that is the only bucket. Matches the `mode()` `lib/storage/cluster-label-fallback.ts → composeDeterministicLabel` already uses. |
| `dominant_topic_count` | Bucket count for the dominant slug. |
| `dominant_topic_share` | `dominant_topic_count / observation_count` (NUMERIC(5,4)). |
| `runner_up_distribution` | `JSONB {slug → count}` over `evidence.scoring.runner_up`. |
| `avg_confidence_proxy` | Mean of `evidence.scoring.confidence_proxy` (each member's value is clamped to `[0, 1]` by Layer 0). NULL when no member has current-version evidence. |
| `avg_topic_margin` | Mean of `evidence.scoring.margin` — i.e. `winnerScore − runnerUpScore` in raw weighted-phrase units. **Not bounded to `[0, 1]`**: a single observation with several w4 title phrases routinely produces margin ≥ 100, so the column is `numeric(12,4)` to absorb realistic AVG values. NULL when no member has current-version evidence. |
| `low_margin_count` | Members with `margin <= 2` (the v5/v6 default threshold; close calls between Topics). |
| `mixed_topic_score` | Shannon entropy of `topic_distribution`, normalised to `[0, 1]` by `ln(bucket_count)` and clamped at 1 to absorb FP epsilon on the cast. **Includes the `unclassified` bucket**, so a half-classified Family can read as "mixed" even when its classified half is one Topic — pair with `classification_coverage_share` to tell the two apart. |
| `common_matched_phrases` | Top 10 `(slug, phrase)` tuples by frequency across all members' `evidence.matched_phrases`, ordered count-desc / slug-asc / phrase-asc. The same surface phrase can score for more than one slug, so the slug is part of the unique unit of evidence. Phrase rows whose `slug` field is missing/empty/non-string from the evidence JSONB are bucketed under the literal slug `unknown` (matched at both layers — `028:178` and `cluster-topic-metadata.ts:142`). The taxonomy in `scripts/002` does not contain a real `unknown` slug, so the bucket cannot collide with a real Topic decision. |

The MV is wired into the existing `refresh_materialized_views()` hook
so the same cron tick that refreshes `mv_observation_current` /
`mv_cluster_health_current` keeps it fresh. The unique index on
`cluster_id` gates `REFRESH MATERIALIZED VIEW CONCURRENTLY`, which the
hook uses on every refresh — no exclusive lock during refresh.

#### Architectural contract

- **Layer 0 stays observation-level.** This MV is a downstream read
  model; it does not write to `category_assignments` and does not
  alter `CATEGORY_PATTERNS`, the LLM tiebreaker plan, or the
  embedding pipeline.
- **Layer A stays embedding-first.** Cluster membership is decided by
  cosine similarity in `lib/storage/semantic-clusters.ts`
  (§4.1–4.3). `dominant_topic_slug` and `mixed_topic_score` are
  *labels on what the embedding pass already produced* — never
  inputs back into the clustering decision.
- **`mixed_topic_score` is a hint, not a gate.** A high value flags
  a Family for human review (genuinely multi-causal vs.
  split-needed). Auto-splitting on entropy is deferred until we have
  a labelled eval set (§10 Future Improvements).
- **`dominant_topic_slug` is consistent with the labeller's
  fallback.** Both pick the lex-tiebroken mode, so the deterministic
  cluster name and the cluster's dominant Topic agree by
  construction (no separate source of truth).
- **The family-name prompt is unchanged.** The labeller still
  receives the topic slug computed in-process from member rows; it
  does not read this MV. (A future pass may swap in the MV's
  `dominant_topic_slug` once it has been steady-state for one
  refresh cycle, but that is a separate change.)
- **No manual override UI yet.** The MV is read-only — no
  reviewer-mutable columns. Adding a reviewer override would live on
  `clusters` (alongside `label_human` per §10.4), not here.

#### Read path

`lib/storage/cluster-topic-metadata.ts` exposes:

```ts
getClusterTopicMetadata(supabase, clusterId): Promise<ClusterTopicMetadata | null>
listClusterTopicMetadata(supabase, {
  clusterIds?, minObservationCount?, minMixedTopicScore?,
  dominantTopicSlug?, limit?,
}): Promise<ClusterTopicMetadata[]>
```

Both helpers do NUMERIC-string → JS-number coercion at the boundary
(Postgres NUMERIC arrives as a string via supabase-js) and preserve
the NULL-vs-0 distinction for averages so "no current-version evidence
yet" stays distinguishable from "computed average is zero". A pure
`rowToMetadata` plus the coercion helpers are exported via `__testing`
for unit coverage in `tests/cluster-topic-metadata.test.ts`.

There is intentionally no admin/debug route in this pass: the existing
`/api/clusters` chip-strip surface composes
`mv_cluster_health_current` and the `clusters` label row, and adding
a third join here without a UI consumer would be premature
abstraction. When a Family-detail panel surfaces topic distribution
to reviewers, it can call `getClusterTopicMetadata(...)` directly
from the server component.

#### Example queries

```sql
-- Families dominated by a single Topic (likely homogeneous,
-- low-review priority).
select cluster_id, dominant_topic_slug, dominant_topic_share, observation_count
from mv_cluster_topic_metadata
where dominant_topic_share >= 0.8
  and observation_count >= 5
order by observation_count desc;

-- Mixed Families that may need a split-review (filter for high
-- coverage so the score reflects topic mix, not missing evidence).
select cluster_id, mixed_topic_score, classification_coverage_share,
       observation_count, topic_distribution
from mv_cluster_topic_metadata
where mixed_topic_score >= 0.6
  and classification_coverage_share >= 0.8
  and observation_count >= 5
order by mixed_topic_score desc, observation_count desc;

-- Families where the high mixed score is actually a Layer 0 backlog
-- (low coverage) rather than a real multi-topic Family.
select cluster_id, mixed_topic_score, classification_coverage_share,
       unclassified_count, observation_count
from mv_cluster_topic_metadata
where mixed_topic_score >= 0.6
  and classification_coverage_share < 0.5
order by unclassified_count desc;

-- Phrases that recur across a specific Family's evidence, with the
-- slug each phrase was scored under.
select common_matched_phrases
from mv_cluster_topic_metadata
where cluster_id = '<uuid>';
```

---

## 5) Classification Integration

Clustering and classification are now coordinated in the same scrape lifecycle:

1. Scrape run collects `ClassificationCandidate` objects from newly observed rows.
2. Queue processor checks whether observation already has a classification (unless reclassify policy is enabled).
3. It classifies via shared `classifyReport(...)` logic used by `/api/classify` endpoint.
4. Validation is strict (schema, enums, evidence quote substring checks).
5. Low-confidence outputs can retry on larger model.

Outcome: triage lane has fresh rows after scrape runs, and cluster-based triage controls have actual records to operate on.

---

## 6) Reliability and Safety Model

### 6.1 Reliability principles
- **Never block ingestion on OpenAI calls.**
- **Always attach to some cluster** (semantic or deterministic).
- **Always name the cluster you attached to** — every cluster has
  `label IS NOT NULL` and `label_confidence >= 0.4` after the
  labeller runs (§4.4.1). LLM unavailability degrades label quality,
  not label presence.
- **Log failures, continue processing.**

### 6.2 Observability
Run results expose:
- processed count
- semantic attach count
- fallback attach count
- embedding failures
- labeling failures

Per-cluster row-level audit:
- `clusters.label_model` — six possible values that distinguish LLM
  vs. deterministic source and which deterministic rung fired
  (§4.4.5). Queryable directly for "what fraction of recent labels
  needed fallback?".

Time-series:
- Structured server log `component: cluster-labeling, event:
  deterministic_fallback_used` per fallback write (§4.4.6). Watch the
  rate as a leading indicator of LLM label-quality drift.

Classification queue also logs attempted/classified/skipped/failed counts.

### 6.3 Replay and versioning
Embedding and semantic labeling use algorithm-version tags (`observation_embedding`, `semantic_cluster_label`) so improvements can be rolled out safely and compared historically. The labeller bumped v1 → v2 in 2026-04-26 to introduce the deterministic fallback ladder (§4.4); the one-shot backfill `scripts/021_backfill_deterministic_labels.ts` (§4.4.7) restates v1 stub rows under the v2 contract. Old `algorithm_version = 'v1'` rows are not deleted — `?as_of=T` queries against pre-migration timestamps still see the original v1 stubs.

---

## 7) API and UI Implications

### API
- `/api/classify` now delegates to shared classification pipeline code, reducing drift between manual and automated classification paths.
- `/api/classifications` joins each response row to its observation's current cluster membership and surfaces `cluster_id`, `cluster_key`, `cluster_label`, `cluster_label_confidence`, and `cluster_size`. Implementation fans out two extra Supabase queries against `clusters` and `cluster_members` (filtered by `detached_at IS NULL`) after the observation fetch resolves.
- **`/api/clusters`** reads clusters **directly from `mv_observation_current`** (independent of classifications) so the triage chip strip can render when zero classifications exist. Query params: `?days=N` (optional window) and `?limit=N` (default 20, max 100). Returns `{ clusters: ClusterSummary[], windowDays, source: "observations" }`. Each cluster includes `in_window` (count in the requested window), `size` (total active members across all time from `cluster_frequency`), `classified_count` (subset with `llm_classified_at IS NOT NULL`), and up to 3 `samples` (top-impact member titles). Pure aggregation lives in `lib/classification/clusters.ts` → `aggregateClusters()` so it can be unit-tested without Supabase.

### UI — vocabulary lock
The word "cluster" is reserved for the Layer-A semantic/title-hash clustering documented here. Everything else in the triage UI uses different language so the three layers stay legible at a glance:

| Surface | Name in code | UI label | What it actually is |
| --- | --- | --- | --- |
| Global slider | `categoryValue` / `onCategoryChange` | **Topic focus** | 1-of-N heuristic regex bucket filter (no grouping) — see `docs/ARCHITECTURE.md` §6.0 |
| Triage chip strip | `groupFilter` | **Top triage groups** | Client-side group-by on `(effective_category, subcategory)` — uses LLM strict-schema fields |
| Triage chip strip (second row) | `clusterFilter` (URL: `?cluster=`) | **Top semantic clusters** (technical) / **"Families"** (user copy) | This document — Layer-A clusters rendered from the new API fields. Shown in the dashboard's "Top Families" section. |
| Priority Matrix | `lanes` | **Lanes** | Client-side group-by on heuristic `category.name` (a Topic) |

Historical `clusterFilter` / "TOP CLASSIFICATION CLUSTERS" / "Clustered classification lanes" copy and identifiers were renamed to the table above to eliminate collision; the Vercel Analytics event key `cluster_filter` is retained for back-compat and populated from the renamed `groupFilter` state.

Two follow-up renames landed in a later pass (see `docs/ARCHITECTURE.md` §6.0):

- **"Category focus" slider → "Topic focus"** in the global filter bar. The heuristic regex bucket is surfaced as "Topic" everywhere in user copy, leaving "category" reserved for the LLM strict-schema enum (`classifications.category`).
- **"Cluster label" placeholder strings → Family name with deterministic fallback.** Originally any cluster whose `label_confidence` sat below the `0.6` floor rendered "Unnamed family" in the UI. With `semantic_cluster_label` v2 the labelling pipeline writes a deterministic Topic+error fallback at confidence `>= 0.4` for every cluster, so the UI show-threshold is now `0.4` and the placeholder is reserved for the `label IS NULL` defence-in-depth case (rendered as `Cluster #<short-id>`). Code identifier `cluster_label` is unchanged. See §4.4 for the full source-priority chain.

### UI — triage behavior
- Triage UI distinguishes:
  - pipeline-empty (no classifications generated yet) — renders a **pipeline status panel** (see below),
  - scope-empty (filters remove existing records).
- Group filter controls are disabled when no groups exist, with explicit tooltip guidance.

#### Pipeline status panel
When the triage queue is empty (no classifications in the current window), the empty state renders a live prerequisite breakdown rather than a generic "no data" message. Data source: `GET /api/classifications/stats?days=<N>` → `prerequisites` field, which runs four parallel count queries against `mv_observation_current` and `scrape_logs`.

Each row reports one prerequisite step with a ✓ / ⚠ / ✗ icon:

| Row | Source | Interpretation |
| --- | --- | --- |
| Observations in scope | `mv_observation_current` count filtered by `is_canonical` + window | ✓ > 0 |
| Semantic clustering | `cluster_id IS NOT NULL` ratio | ✓ 100%, ⚠ partial, ✗ 0% |
| Classifications | `llm_classified_at IS NOT NULL` ratio | ✓ 100%, ⚠ partial, ✗ 0% |
| OpenAI API key | `process.env.OPENAI_API_KEY` | ✓ set, ✗ missing |
| Last scrape | most recent `scrape_logs` row with `source_id IS NOT NULL` | relative time |
| Last classify-backfill | most recent `scrape_logs` row with `source_id IS NULL` | relative time |

The panel's primary CTA is picked by `pickPrimaryCta(prereq)` in `lib/classification/prerequisites.ts` with deliberate precedence:
1. `observationsInWindow === 0` → no CTA (upstream fix needed: wait for scrape / check cron).
2. `!openaiConfigured` → inline warning; no click-through (backfill would 503).
3. `pendingClassification > 0` → **"Run Layer C Backfill →"** linking to `/admin?tab=classify-backfill`.
4. `pendingClustering > 0` (and classification caught up) → **"Rebuild Layer A clustering →"** linking to `/admin?tab=clustering`.
5. All caught up → no CTA (panel shouldn't render anyway; defensive).

When primary is the Layer C Backfill CTA and clustering is also behind, a secondary "Rebuild Layer A clustering" button renders alongside to save the reviewer a round-trip. Prereq fetch failures (server-side log via `logServerError` component `api-classifications-stats`) degrade to a minimal fallback panel — no 500, no blank card.

- The semantic-cluster chip strip reads from `/api/clusters` (sourced from `mv_observation_current`), not from the classification queue. This decouples the cluster surface from the classification pipeline — clusters are visible the moment an observation is ingested with a `cluster_id`, without waiting for classify-backfill to populate matching classification records. When a chip is selected but the triage table is empty (either pre-classification or compound-filter pruned it), a **cluster-member preview panel** renders below the chip strip showing the cluster's top-impact observations with source links, so reviewers can see what's actually in the cluster instead of staring at an empty table.
- Cluster labels render as **"Unlabelled cluster"** when `cluster_label` is null. Raw `cluster_key` values (`semantic:<digest>` or `title:<md5>`) are implementation detail and surface only through a `title=` attribute tooltip — never as user-facing copy.
- The triage detail panel shows a "Semantic cluster" block with label, member count, and confidence (2dp) whenever the selected record has a `cluster_id`.
- The group filter and the semantic-cluster filter **compose with AND**: a record must match both to appear in the triage table. The scoped-empty state names the filter(s) to clear so reviewers can widen the view without guessing.

#### Layered explainer + per-record context

The triage card surfaces the three layers explicitly so reviewers don't have to read this doc to triage:

- **`LayerExplainerPanel`** — a collapsible "How this works" card directly under the KPI strip. Definitions for Layer A (semantic cluster), Layer B (triage group), Layer C (the row), each with a deep-link to the admin tab that owns the relevant pipeline step. Open/closed state persists in `localStorage` under `classification-triage:layer-explainer-open`; first render is always closed (SSR-safe).
- **Layer badges (`A` / `B` / `C`)** are mounted on the section headings and on every row breadcrumb so the vocabulary in the explainer maps unambiguously to surfaces.
- **`LayerBreadcrumb`** — `A: <cluster label> › B: <category › subcategory> › C: <id8>`. Compact form on every table row (drops the C suffix); full form in the reviewer panel header. When `cluster_id` is null the A segment renders as "no cluster" so the visual rhythm of all three layers is preserved.
- **`ClassificationContextPanel`** — the full Layer-C body for the selected record. Renders only the schema fields that are populated (`reproducibility`, `impact`, `root_cause_hypothesis`, `suggested_fix`, `evidence_quotes`, `tags`) plus model provenance (`model_used`, `retried_with_large_model`, `algorithm_version`). Evidence quotes are tagged "substring-validated against source" because `lib/classification/schema.ts` → `evidenceQuotesAreSubstrings` enforces it server-side; surfacing the validation builds reviewer trust.
- **`PerRecordPrereqHints`** — small inline hints when a selected row has a Layer-A miss (no `cluster_id`), low confidence (`< 0.7`, the same threshold that triggers large-model escalation in the pipeline), or the LLM flagged it for human review (`review_reasons` is non-empty). Each hint deep-links to the `/admin` tab that owns the fix; generic "something is off" messages are deliberately avoided.

#### Partial-pipeline strip

`PipelineStatusPanel` covers the empty-pipeline state. The middle state — *some* classifications exist but `pendingClassification > 0` or `pendingClustering > 0` — is covered by **`PartialPipelineStrip`**: a single-line amber banner under the KPI cards that shows `classified%` / `clustered%` for the current window plus the same primary CTA (`pickPrimaryCta(prereq)`) used by the empty-state panel. Hidden when caught up (`cta.kind === "none"`) so it doesn't nag during steady-state operation.

---

## 8) Operational Controls

### Tunables
- `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`)
- `OPENAI_CLUSTER_LABEL_MODEL` (default `gpt-5-mini`) — small-pass label model
- `OPENAI_CLUSTER_LABEL_MODEL_LARGE` (default: same as small) — escalation label model. Setting it to a larger model opts that deployment into the small→large escalation pattern at the cost of one extra OpenAI call per low-confidence first pass. Mirrors `CLASSIFIER_MODEL_LARGE`.
- semantic similarity threshold (default `0.86`)
- `minClusterSize` (default `2`)
- `CLUSTER_LABEL_CONFIRM` (env, no default) — required `=yes` to let `scripts/021_backfill_deterministic_labels.ts --apply` write to the DB. Refusal exit code `2` otherwise.

### Recommended defaults
- Start conservative: high threshold, small minimum cluster size.
- Leave `OPENAI_CLUSTER_LABEL_MODEL_LARGE` unset until the per-cluster `deterministic_fallback_used` log rate (§4.4.6) shows a steady-state baseline; opt in to escalation if the fallback rate from low-confidence first-pass labels is the dominant slice.
- Increase semantic coverage gradually while monitoring fallback rate and label quality.

---

## 9) Risks and Mitigations

1. **False semantic merges**
   - Mitigation: conservative threshold; fallback path; review through admin tools.
2. **Model downtime / quota limits**
   - Mitigation: deterministic membership fallback (§4.5) **and** deterministic *label* fallback (§4.4); failure logging.
3. **Label quality drift**
   - Mitigation: store label confidence/model/algorithm version per row for auditing (§4.4.5); structured `deterministic_fallback_used` log event per fallback write (§4.4.6) as a leading indicator.
4. **Deterministic-label false confidence**
   - Risk: A `Bug cluster · ENOENT` label *looks* trustworthy at confidence `0.55` but is mechanically derived, not LLM-curated. Reviewers might over-trust it.
   - Mitigation: `clusters.label_model` distinguishes `openai:*` from `deterministic:*` for any audit query; the "High confidence" badge is gated separately at `0.8` (§4.4.3) so only LLM-confident labels carry that visual marker.
5. **Cost growth with scale**
   - Mitigation: embedding cache + only process new observations by default. Escalation to `OPENAI_CLUSTER_LABEL_MODEL_LARGE` is opt-in (§8 Tunables) and only fires for low-confidence first passes, bounded by the cluster count (not observation count) per batch.
6. **Threshold drift between producer and consumer**
   - Risk: A future engineer changing the labeller's confidence floor without updating the UI render sites (or vice-versa) silently re-introduces "Unnamed family"-class regressions.
   - Mitigation: producer and consumer thresholds are both `0.4` and reference each other via comments at `cluster-label-fallback.ts:78` and `classification-triage.tsx:111`. The producer's lowest-rung confidence equals the consumer's show-floor; this self-enforcing contract is documented in §4.4.3 and §4.4.8.

---

## 10) Future Improvements

1. Add incremental nearest-neighbor search to reduce O(n²) pairwise comparisons for large batches.
2. Add optional cross-batch semantic rebalancing job for long-tail consolidation.
3. **Tune clustering cohesion** — sweep `similarityThreshold` (currently `0.86`) and `minClusterSize` against a labelled eval set. Deferred from the labelling-pipeline pass (§4.4) because changing those re-shapes Family membership for every existing user; needs a precision/recall harness before any change ships.
4. **In-app reviewer feedback loop on Family names** — UI affordance to rate / correct labels, plus schema for human-supplied labels (`clusters.label_human`, `label_human_actor`, `label_human_at`), plus precedence rules (`human` > `openai-high` > `deterministic` > `openai-low`). Substantial UX + auth work; deferred. The current row-level audit (§4.4.5) is the prerequisite that makes this future work tractable.
5. Add quality metrics (cluster purity/cohesion proxies) into admin dashboards.

---

## 5.1) Family Classification (Layer A interpretation)

`family_classifications` is a per-cluster *interpretation* layer that sits
on top of `mv_cluster_topic_metadata` (Layer A evidence aggregation, §4.6).
It is **not** a clustering change or a labelling override — it is a
read-only interpretation record whose only job is to assign a coherence
verdict, an optional human-readable title/summary, and a review flag to
each Layer A cluster.

### What Family Classification does

For each cluster, assign:
- **family_kind** (heuristic-first, deterministic): one of:
  - `coherent_single_issue` — dominant topic share ≥ 75%
  - `mixed_multi_causal` — high topic mixedness + high coverage AND members
    are confidently classified (few low-margin) — genuinely multi-causal
    but tractable
  - `needs_split_review` — same shape as `mixed_multi_causal` but with many
    low-margin members, signalling Layer 0 is also unsure of the boundaries
  - `low_evidence` — coverage < 50% (too many members unclassified)
  - `unclear` — mixed signals that don't fit the above rules
- **needs_human_review** (boolean) and **review_reasons[]** machine codes:
  `low_classification_coverage`, `high_topic_mixedness`,
  `many_close_topic_calls`, `mixed_or_unclear_signals`,
  `fallback_cluster_path`, `low_avg_layer0_confidence`,
  `llm_disagrees_with_heuristic`
- Optional **LLM-generated** title, summary, primary_failure_mode,
  affected_surface, likely_owner_area, plus a `suggested_family_kind`
  used as a disagreement signal only
- **Evidence JSONB snapshot**: cluster topic metadata, structured
  representative observations (`observation_id`, `title`, `body_snippet`,
  `topic_slug`, `is_canonical`), and an `llm` block with status +
  provenance

### What Family Classification does NOT do

- Does not change `cluster_members` (membership is embedding-first, owned by
  `lib/storage/semantic-clusters.ts`)
- Does not overwrite `clusters.label` (cluster display name stays independent
  of the family interpretation)
- Does not split or merge clusters automatically (flagged for review only)
- Does not mutate Layer 0 evidence or category_assignments
- Does not become ground-truth by default (reviewer must accept it before
  routing/dedup uses it)
- The LLM **never overwrites** `family_kind`. If the LLM's
  `suggested_family_kind` disagrees with the heuristic, the heuristic
  result is preserved and `llm_disagrees_with_heuristic` is appended to
  `review_reasons` (forcing `needs_human_review = true`).

### Rules (heuristic-first)

Run deterministically on every cluster. Auxiliary signals first
(accumulate review reasons), then four mutually-exclusive kind rules:

```
auxReasons = []
if cluster_path == "fallback":           auxReasons += ["fallback_cluster_path"]
if avg_confidence_proxy != null
   and avg_confidence_proxy < 0.3:       auxReasons += ["low_avg_layer0_confidence"]

if classification_coverage_share < 0.5:
  family_kind = "low_evidence"
  review_reasons = ["low_classification_coverage"] + auxReasons
  needs_human_review = true

else if mixed_topic_score >= 0.6 and classification_coverage_share >= 0.8:
  if low_margin_count / observation_count >= 0.4:
    family_kind = "needs_split_review"
    review_reasons = ["high_topic_mixedness", "many_close_topic_calls"] + auxReasons
    needs_human_review = true
  else:
    family_kind = "mixed_multi_causal"
    review_reasons = ["high_topic_mixedness"] + auxReasons
    needs_human_review = (auxReasons not empty)

else if dominant_topic_share >= 0.75:
  family_kind = "coherent_single_issue"
  review_reasons = auxReasons
  needs_human_review = (auxReasons not empty)

else:
  family_kind = "unclear"
  review_reasons = ["mixed_or_unclear_signals"] + auxReasons
  needs_human_review = true
```

Optional LLM enrichment (heuristic stays authoritative):
- Call `callFamilyTitleModel(...)` with structured representatives
  (canonical observation first, then recent active members; each carries
  `observation_id`, `title`, `body_snippet`, `topic_slug`).
- Strict-mode JSON schema: returns `family_title`, `family_summary`,
  `primary_failure_mode`, `affected_surface`, `likely_owner_area`,
  `confidence`, `rationale`, and `suggested_family_kind`.
- On failure or `confidence < 0.5`, fall back to deterministic
  `"{Title-Cased Topic} — {top phrase}"` with input-sensitive confidence
  `clamp(min(coverage, dominant_share), 0.2, 0.6)`.
- `evidence.llm.status` always set, even when the call didn't happen:
  `succeeded | failed | skipped_missing_api_key | skipped_no_representatives | low_confidence_fallback`.

### Table + View

**family_classifications** (append-only, one row per classification):
- `cluster_id`, `algorithm_version`, `family_title`, `family_summary`, `family_kind`,
  `dominant_topic_slug`, `primary_failure_mode`, `affected_surface`,
  `likely_owner_area`, `severity_rollup`, `confidence`, `needs_human_review`,
  `review_reasons[]`, `evidence` (JSONB snapshot), `computed_at`

**family_classification_current** (view picking latest per cluster):
- Same columns, filtered by `distinct on (cluster_id) order by computed_at desc`

### Admin panel

New tab "Family Classification" in `/admin`:
- Stats: total clusters, clusters without classification
- Single-cluster lookup: paste cluster UUID, see draft result
- Dry-run: count candidates without running classifier
- Batch: process top N unclassified clusters

### Reads

- `lib/storage/family-classification.ts` → `classifyClusterFamily(supabase, clusterId)`
  Returns `FamilyClassificationDraft` (heuristic + optional LLM)
- `/api/admin/family-classification` (POST) → runs classification + writes to DB

### Architectural contract

- **Reviewer feedback loop is a separate read-side surface** — reviewers can
  mark a classification correct/incorrect/unclear via §5.2 below. Reviews are
  append-only and never mutate `family_classifications` or
  `quality_bucket`; they exist purely to feed precision/recall analysis.
- **Latest-only by default** — `family_classification_current` view hides
  older classifications, but older rows stay queryable via the table directly
  for audit queries like "how did this family's classification change over
  time?"
- **Never fed back into clustering** — the family_kind is a *label* on what
  the embedding pass already created, never an input to the embedding pass
  or member re-assignment.
- **Severity_rollup is a placeholder** — stored as `unknown` in v1; a future
  pass can infer it from `danger level` in the LLM response or map
  family_kind → severity heuristically.

## 5.2) Family Classification Quality Reviews

`family_classification_reviews` (migration 030) captures reviewer feedback
on whether a Family Classification row got the answer right. It is the
evaluation loop for the classification system, **not** a ticketing or
routing workflow.

### Stage 5 review contract

This is **Stage 5** feedback for **Stage 4** family classification +
family naming + deterministic fallback. Reviews are the ground-truth
signal future eval / Improvement Workbench (#164) reads back to decide
which Stage to improve next. Reviews are append-only and never mutate
`family_classifications`, `quality_bucket`, clustering output, or
prompts — they are pure read-side evaluation.

Each review answers four questions, one per column. They must stay
unambiguous so the Workbench can hill-climb cleanly:

- **`review_verdict`** — *Is the current stored/displayed classification
  acceptable?* (`correct` / `incorrect` / `unclear`.) Judged against
  what a downstream consumer would see, not against an internal stage.
- **`review_decision`** — *How did the human resolve the tie or
  uncertainty?* Captured when heuristic and LLM disagreed, or when the
  reviewer wants to record a non-binary outcome (split, low-evidence,
  needs-more-examples, etc.).
- **`error_source`** — *Which Stage / root cause should be improved?*
  Aligned with the 5-stage pipeline vocabulary so a spike in
  `stage_4_llm_classification` directly points at the LLM prompt,
  `stage_3_clustering` at the clustering threshold, etc.
- **`evidence_snapshot.tie_break_context`** — frozen audit context
  (heuristic kind, LLM suggested kind, llm_disagrees, the chosen
  review_decision) so a later run of the Improvement Workbench can
  see "what did the reviewer have on screen, and which side did they
  pick?" without re-deriving from a possibly-mutated classification.

#### Canonical decision/verdict pairs

The validator enforces only the *contradictory* combinations; everything
else is permitted and the dashboard surfaces meaning via independent
per-decision tiles. Reviewers should aim for these canonical pairs:

| verdict     | decision                | meaning                                                        |
|-------------|-------------------------|----------------------------------------------------------------|
| `correct`   | `accept_heuristic`      | Stored output is acceptable; heuristic wins the tie.           |
| `correct`   | `accept_llm`            | *Only* on agreement rows — LLM was the better rationale, both happened to pick the same kind. |
| `incorrect` | `accept_llm`            | Stored output is wrong; the LLM's suggestion is the better answer. |
| `incorrect` | `override_family_kind`  | Reviewer supplies the expected family kind themselves.         |
| `incorrect` | `mark_low_evidence`     | Family should be treated as low-evidence, not coherent.        |
| `unclear`   | `mark_low_evidence`     | Same, when the reviewer also can't commit to incorrect.        |
| `unclear`   | `needs_more_examples`   | Not enough evidence to decide — wait for more reps.            |
| `incorrect` | `should_split_cluster`  | Cluster contains multiple distinct issues; Stage 3 / reps fault. |
| `unclear`   | `should_split_cluster`  | Same, when the reviewer can't fully commit.                    |
| any         | `mark_general_feedback` | Family is general feedback, not actionable as a single issue.  |
| any         | `not_actionable`        | Issue exists but no useful follow-up.                          |

**Rejected by the validator:** `correct + accept_llm` on disagreement
rows. If the LLM suggested a different kind than the stored one, "accept
the LLM" semantically means the stored output is wrong — verdict must
be `incorrect`, not `correct`. Without this rule the Workbench can't
tell which side the human picked.

**Default:** `should_split_cluster` defaults `error_source` to
`stage_3_clustering` when unset; otherwise the only allowed values are
`stage_3_clustering` and `representative_selection` — those are the
only places a "should split" decision is actionable upstream.

#### Concrete example: low-evidence overflag

A cluster has 3 reps that all read like single-line "doesn't work"
complaints. The classifier ran Stage 4, the LLM came back with status
`succeeded` and suggested `low_evidence`, but the deterministic
fallback resolved to `coherent_single_issue` (the heuristic was lenient
here). The dashboard surfaces it as `needs_review` with a
`llm_disagrees_with_heuristic` review reason, and the reviewer agrees
with the LLM:

```jsonc
{
  "review_verdict": "incorrect",
  "review_decision": "mark_low_evidence",
  "expected_family_kind": "low_evidence",  // auto-set by validator
  "actual_family_kind": "coherent_single_issue",
  "error_source": "stage_4_family_naming",
  "error_reason": "low_evidence_should_not_be_coherent",
  "notes": "3 single-line reps with no concrete failure mode",
  "evidence_snapshot": {
    "tie_break_context": {
      "heuristic_family_kind": "coherent_single_issue",
      "llm_suggested_family_kind": "low_evidence",
      "llm_disagrees": true,
      "review_decision": "mark_low_evidence"
    }
    // … bounded family_title, representative_preview, llm.rationale, etc.
  }
}
```

The Improvement Workbench reading this back can attribute the error to
Stage 4 family naming (the fallback), see the heuristic was the wrong
choice for this row, and bucket it with other `low_evidence_should_not_be_coherent`
rows for a Stage 4 fallback / threshold tightening pass.

### What this is

- An **append-only** table of reviewer verdicts per `family_classifications`
  row. One row per review event; older reviews stay queryable for audit.
- A small **inline form** inside the existing Family Quality Dashboard row
  detail. Reviewers see the same evidence (title, summary, representatives,
  matched phrases, LLM rationale, quality bucket) the dashboard renders, then
  pick Correct / Incorrect / Unclear.
- A **directional precision/recall summary** card at the top of the Family
  Quality section. Tiles include `safe_to_trust_precision`,
  `needs_review_correct`, `input_problem_confirmed`, top error_source,
  top error_reason, and a dedicated tile per `review_decision`
  (`tie_break_reviewed_count`, `heuristic_accepted_count`,
  `llm_accepted_count`, `override_family_kind_count`,
  `low_evidence_override_count`, `general_feedback_marked_count`,
  `needs_more_examples_count`, `should_split_cluster_count`,
  `not_actionable_count`). Marked as not statistically significant
  until enough rows exist.
- A **human tie-break section** in the row detail that surfaces whenever
  heuristic and LLM disagreed (or the row was otherwise flagged for human
  review). The reviewer records a `review_decision` so a later analysis
  can answer "when heuristic and LLM disagreed, which did the human pick?"

### What this is NOT

- **Not ticketing.** No file/dismiss/defer/dedupe state. No `ticket_url`.
  No external-issue mirror.
- **Not approve/reject.** Reviews never mutate `family_classifications`,
  never change `quality_bucket`, never re-run classification, never split
  or merge clusters, never touch Layer 0 evidence or
  `category_assignments`.
- **Not a routing surface.** No PR automation, no GitHub issue creation,
  no automatic fixes downstream.
- **Not a queue.** Rows do not disappear from the dashboard after review.

### Schema sketch

`family_classification_reviews` (append-only):
- `id`, `classification_id` (FK → `family_classifications.id`),
  `cluster_id` (FK → `clusters.id`),
- `review_verdict` ∈ `correct | incorrect | unclear`,
- `review_decision` (nullable tie-break outcome) ∈ `accept_heuristic |
  accept_llm | override_family_kind | mark_low_evidence |
  mark_general_feedback | needs_more_examples | should_split_cluster |
  not_actionable`,
- `expected_family_kind` (nullable; required when
  `error_reason = wrong_family_kind` or
  `review_decision = override_family_kind`; auto-set to `low_evidence`
  when `review_decision = mark_low_evidence`),
- `actual_family_kind` (snapshot of the classifier's `family_kind` at
  review time),
- `quality_bucket` (snapshot of the dashboard bucket at review time),
- `error_source` aligned with the 5-stage classification pipeline
  (PR #162) ∈ `stage_1_regex_topic | stage_2_embedding | stage_3_clustering
  | stage_4_llm_classification | stage_4_family_naming | stage_4_fallback
  | stage_5_review_workflow | representative_selection | data_quality |
  unknown`,
- `error_reason` ∈ `wrong_family_kind | bad_family_title | bad_family_summary
  | bad_representatives | bad_cluster_membership | llm_hallucinated |
  llm_too_generic | heuristic_overrode_better_llm_answer |
  llm_disagreed_but_was_wrong | low_evidence_should_not_be_coherent |
  general_feedback_not_actionable | singleton_not_recurring |
  mixed_cluster_should_split | false_safe_to_trust | false_needs_review
  | false_input_problem | other`,
- `notes`, `reviewed_by`, `reviewed_at`,
- `evidence_snapshot` JSONB — bounded freeze of what the reviewer saw
  (family_title, family_summary, family_kind, quality_bucket,
  quality_reasons, representative_preview, common_matched_phrase_preview,
  llm.status / suggested_family_kind / rationale, cluster_topic_metadata
  fields, plus a `tie_break_context` block recording heuristic vs LLM
  family_kind and the reviewer's `review_decision`).

`family_classification_review_current` view: `distinct on (classification_id)
order by reviewed_at desc` — latest verdict per classification, mirrors the
`family_classification_current` pattern from §5.1.

### Validation

- `correct`: `error_source` and `error_reason` are forced to null on the
  way in.
- `incorrect`: requires `error_source` AND `error_reason`.
- `incorrect` AND `error_reason = wrong_family_kind`: also requires
  `expected_family_kind`.
- `unclear`: notes recommended but `error_source` / `error_reason`
  remain optional so combinations like `unclear + needs_more_examples`
  work without forcing a fake error.
- `review_decision = override_family_kind` (independent of verdict):
  requires `expected_family_kind`.
- `review_decision = mark_low_evidence` (independent of verdict): the
  validator auto-sets `expected_family_kind = low_evidence` so the
  reviewer doesn't have to repeat the choice.
- `review_decision = should_split_cluster` (independent of verdict):
  the validator defaults `error_source` to `stage_3_clustering` when
  unset, and otherwise constrains it to `stage_3_clustering` or
  `representative_selection`.
- `review_verdict = correct` AND `review_decision = accept_llm` is
  rejected when the LLM disagreed with the heuristic
  (`llmSuggestedFamilyKind != actualFamilyKind`). See "Stage 5 review
  contract" above for rationale.

The validator (`lib/admin/family-classification-review.ts →
validateFamilyClassificationReviewInput`) is shared between the API
route and the UI form so the 400 response messages match the form
guards exactly.

### How errors map to follow-up work

The summary tiles surface trends, not tickets. A spike in any single
`error_reason` or `error_source` means a specific Stage of the pipeline
needs work:

- repeated `wrong_family_kind` → revisit Stage 4 family-classification
  heuristic (`lib/storage/family-classification.ts`); consider a v2 bump.
- repeated `bad_representatives` → fix representative-selection
  (`mv_cluster_topic_metadata` consumers); error_source =
  `representative_selection`.
- repeated `stage_1_regex_topic` → tighten Stage 1 regex / topic
  guardrails; add to the topic-classifier eval set.
- repeated `stage_3_clustering` / `bad_cluster_membership` → revisit
  clustering threshold or split-review work (`lib/storage/semantic-clusters.ts`).
- repeated `llm_hallucinated` / `llm_too_generic` → bump the Stage 4
  family-prompt template version; consider stricter strict-mode schema.
- repeated `heuristic_overrode_better_llm_answer` → loosen the Stage 4
  fallback / give the LLM more weight on `llm_accepted_count` rows.
- repeated `llm_disagreed_but_was_wrong` → tighten the Stage 4 LLM
  prompt; the heuristic is right more often than the LLM here.
- repeated `false_safe_to_trust` → tighten the strict criteria in
  `computeFamilyQualityBucket`.
- repeated `false_needs_review` → relax the bucket criteria or improve
  the upstream signals being used to flag.

These are *guidance*, not automatic actions. The reviews surface the
trend; the actual fix is a deliberate code change in a follow-up PR.

### API + admin panel surfaces

- `POST /api/admin/family-classification/review` — admin-secret gated.
  Inserts one append-only row. Returns `{ ok: true, review }`. Body
  fields: `classificationId`, `clusterId`, `reviewVerdict`,
  `reviewDecision` (optional), `expectedFamilyKind`, `actualFamilyKind`,
  `llmSuggestedFamilyKind` (validation-only — used to enforce the
  tie-break contract; lands in `evidence_snapshot.tie_break_context`),
  `qualityBucket`, `errorSource`, `errorReason`, `notes`,
  `evidenceSnapshot`.
- `GET /api/admin/family-classification/review` — admin-secret gated.
  Returns `{ rows, summary }`. Filters: `classificationId`, `clusterId`,
  `verdict`, `reviewDecision`, `qualityBucket`, `errorSource`,
  `errorReason`, `limit` (default 50, max 200).
- The Family Quality Dashboard expanded row includes a "Review
  classification quality" form with Correct / Incorrect / Unclear
  buttons. The current row also shows a small pill with the latest
  verdict (or `—` when never reviewed).
- A "Human tie-break" section appears in the row detail **only** when
  heuristic and LLM disagreed (`llm_disagrees_with_heuristic` review
  reason, or `family_kind !== llm_suggested_family_kind`). The
  `review_decision` dropdown captures the reviewer's tie-break choice.

### Validator: permissive on non-contradictory combinations

The validator enforces only the rules listed in "Validation" above plus
the tie-break contract from §5.2 "Stage 5 review contract" (no
`correct + accept_llm` on disagreement rows; `should_split_cluster`
constrains error_source). Beyond those, decision/verdict combinations
are deliberately permitted (e.g. `unclear + needs_more_examples`
without a fabricated error_source, `correct + accept_llm` on agreement
rows). The dashboard tiles surface meaning by counting each decision
independently rather than gating submission. This keeps the form
forgiving and pushes interpretation to read-side analysis.

---

## 11) Success Criteria

The clustering redesign is successful when:
1. Triage panel consistently has non-empty classification records after routine scrape runs.
2. Semantic cluster labels match analyst expectations for top issue families.
3. Fallback rate remains bounded and understood (not silent failure).
4. No ingestion failures are attributable to OpenAI transient errors.
