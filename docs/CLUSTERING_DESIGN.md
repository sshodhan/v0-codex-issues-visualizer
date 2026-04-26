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
3. Run clustering (semantic first, deterministic fallback).
4. Return classification candidate metadata for newly seen observations.

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

The labeller writes one of six possible source tags into
`clusters.label_model`. Resolution order, evaluated per cluster:

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
| `0.4` | UI show-floor | `app/page.tsx`, `app/families/[clusterId]/page.tsx`, `components/dashboard/{dashboard-story-view,v3-view,classification-triage,issues-table}.tsx` |
| `0.4` | Lowest deterministic write | `cluster-label-fallback.ts:78` (`CONFIDENCE_TITLE_ONLY`) |
| `0.55` | Highest deterministic write | `cluster-label-fallback.ts:75` (`CONFIDENCE_TOPIC_AND_ERROR`) |
| `0.6` | LLM accept floor | `semantic-clusters.ts:39` (`LABEL_ACCEPT_BELOW`) |
| `0.7` | LLM escalation trigger | `semantic-clusters.ts:38` (`LABEL_ESCALATE_BELOW`) — matches `pipeline.ts` |
| `0.8` | "High confidence" badge | `classification-triage.tsx:112` (`LABEL_CONFIDENCE_HIGH_THRESHOLD`) — only LLM-confident labels qualify |

**Self-enforcing contract.** The UI show-floor (`0.4`) equals the
lowest deterministic write (`0.4`), so it is impossible for the
labeller to write a value the UI would suppress. A future engineer
adding a new rung at confidence `0.3` would have to lower the UI
floor to match — visible at code-review time as a coupled change.

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
- `label_model` — one of six values (§4.4.1).
- `label_algorithm_version` — `semantic_cluster_label` (currently `v2`).
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
   `label_confidence < 0.6 OR label_model = 'fallback:title'
    OR label IS NULL`. Idempotent: re-running preserves confident
   LLM labels written between runs.
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

Producer (`semantic-clusters.ts:347-358`) guarantees:

> Every cluster row has `label IS NOT NULL` and
> `label_confidence >= 0.4` after the labeller runs.

Consumer (the five render sites) guarantees:

> Anything `label_confidence >= 0.4` is shown verbatim. Anything
> below is impossible (the producer cannot emit it). `label IS NULL`
> is defence-in-depth only — rendered as `Cluster #<short-id>`
> rather than the legacy "Unnamed family" placeholder. The
> `LABEL_CONFIDENCE_HIGH_THRESHOLD = 0.8` separately gates the
> "High confidence" badge so the *quality* signal is preserved at
> a different surface (badge vs name).

Two thresholds, two non-overlapping meanings. Render-site list:

| Surface | File | Threshold check |
|---------|------|------------------|
| Top Families card grid | `app/page.tsx:830` | `cluster.label_confidence >= 0.4` |
| Active-cluster header chip | `app/page.tsx:399` | `row.label_confidence >= 0.4` |
| Story-tab cluster list | `components/dashboard/dashboard-story-view.tsx:88` | `r.label_confidence >= 0.4` |
| V3 prioritized-rails card | `components/dashboard/v3-view.tsx:78` | `cluster.label_confidence >= 0.4` |
| Triage chip strip + detail panel + breadcrumb (3 sites) | `components/dashboard/classification-triage.tsx` | `hasTrustedLabel(...)` (constant `LABEL_CONFIDENCE_SHOW_THRESHOLD = 0.4`) |
| Family-detail page `<h1>` | `app/families/[clusterId]/page.tsx:67` | `data.family.label_confidence >= 0.4` |
| Issues-table active-cluster pill | `components/dashboard/issues-table.tsx:298` | inherits via `activeClusterLabel` prop |

### 4.5 Fallback guarantees
If any of the following occur:
- missing API key,
- embedding request failure,
- label request failure,
- not enough semantically similar neighbors,

then the observation still gets attached through deterministic title hashing (`attachToCluster` with `buildClusterKey`).

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
3. `pendingClassification > 0` → **"Run classify-backfill →"** linking to `/admin?tab=classify-backfill`.
4. `pendingClustering > 0` (and classification caught up) → **"Rebuild clustering →"** linking to `/admin?tab=clustering`.
5. All caught up → no CTA (panel shouldn't render anyway; defensive).

When primary is classify-backfill and clustering is also behind, a secondary "Rebuild clustering" button renders alongside to save the reviewer a round-trip. Prereq fetch failures (server-side log via `logServerError` component `api-classifications-stats`) degrade to a minimal fallback panel — no 500, no blank card.

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

## 11) Success Criteria

The clustering redesign is successful when:
1. Triage panel consistently has non-empty classification records after routine scrape runs.
2. Semantic cluster labels match analyst expectations for top issue families.
3. Fallback rate remains bounded and understood (not silent failure).
4. No ingestion failures are attributable to OpenAI transient errors.
