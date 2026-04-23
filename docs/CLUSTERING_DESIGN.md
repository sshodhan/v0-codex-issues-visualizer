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
- Label model: `OPENAI_CLUSTER_LABEL_MODEL` (default `gpt-5-mini`).
- Prompt requests strict JSON with:
  - `label` (<= 6 words)
  - `rationale` (<= 1 sentence)
  - `confidence` (0..1)
- On failure, use fallback title-based label with low confidence and explicit fallback rationale.

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
- **Log failures, continue processing.**

### 6.2 Observability
Run results expose:
- processed count
- semantic attach count
- fallback attach count
- embedding failures
- labeling failures

Classification queue also logs attempted/classified/skipped/failed counts.

### 6.3 Replay and versioning
Embedding and semantic labeling use algorithm-version tags (`observation_embedding`, `semantic_cluster_label`) so improvements can be rolled out safely and compared historically.

---

## 7) API and UI Implications

### API
- `/api/classify` now delegates to shared classification pipeline code, reducing drift between manual and automated classification paths.
- `/api/classifications` joins each response row to its observation's current cluster membership and surfaces `cluster_id`, `cluster_key`, `cluster_label`, `cluster_label_confidence`, and `cluster_size`. Implementation fans out two extra Supabase queries against `clusters` and `cluster_members` (filtered by `detached_at IS NULL`) after the observation fetch resolves.
- **`/api/clusters`** reads clusters **directly from `mv_observation_current`** (independent of classifications) so the triage chip strip can render when zero classifications exist. Query params: `?days=N` (optional window) and `?limit=N` (default 20, max 100). Returns `{ clusters: ClusterSummary[], windowDays, source: "observations" }`. Each cluster includes `in_window` (count in the requested window), `size` (total active members across all time from `cluster_frequency`), `classified_count` (subset with `llm_classified_at IS NOT NULL`), and up to 3 `samples` (top-impact member titles). Pure aggregation lives in `lib/classification/clusters.ts` → `aggregateClusters()` so it can be unit-tested without Supabase.

### UI — vocabulary lock
The word "cluster" is reserved for the Layer-A semantic/title-hash clustering documented here. Everything else in the triage UI uses different language so the three layers stay legible at a glance:

| Surface | Name in code and UI | What it actually is |
| --- | --- | --- |
| Global slider | **Category focus** | 1-of-N heuristic category filter (no grouping) |
| Triage chip strip | **Top triage groups** | Client-side group-by on `(effective_category, subcategory)` |
| Triage chip strip (second row) | **Top semantic clusters** | This document — Layer-A clusters rendered from the new API fields |
| Priority Matrix | **Lanes** | Client-side group-by on heuristic `category.name` |

Historical `clusterFilter` / "TOP CLASSIFICATION CLUSTERS" / "Clustered classification lanes" copy and identifiers were renamed to the table above to eliminate collision; the Vercel Analytics event key `cluster_filter` is retained for back-compat and populated from the renamed `groupFilter` state.

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
- `OPENAI_EMBEDDING_MODEL`
- `OPENAI_CLUSTER_LABEL_MODEL`
- semantic similarity threshold (default `0.86`)
- `minClusterSize` (default `2`)

### Recommended defaults
- Start conservative: high threshold, small minimum cluster size.
- Increase semantic coverage gradually while monitoring fallback rate and label quality.

---

## 9) Risks and Mitigations

1. **False semantic merges**
   - Mitigation: conservative threshold; fallback path; review through admin tools.
2. **Model downtime / quota limits**
   - Mitigation: deterministic fallback; failure logging.
3. **Label quality drift**
   - Mitigation: store label confidence/model/algorithm version for auditing and future relabel jobs.
4. **Cost growth with scale**
   - Mitigation: embedding cache + only process new observations by default.

---

## 10) Future Improvements

1. Add incremental nearest-neighbor search to reduce O(n²) pairwise comparisons for large batches.
2. Add optional cross-batch semantic rebalancing job for long-tail consolidation.
3. Introduce reviewer feedback loop to tune threshold and relabel strategy.
4. Add quality metrics (cluster purity/cohesion proxies) into admin dashboards.

---

## 11) Success Criteria

The clustering redesign is successful when:
1. Triage panel consistently has non-empty classification records after routine scrape runs.
2. Semantic cluster labels match analyst expectations for top issue families.
3. Fallback rate remains bounded and understood (not silent failure).
4. No ingestion failures are attributable to OpenAI transient errors.
