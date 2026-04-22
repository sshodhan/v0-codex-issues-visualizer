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

### UI
- Triage UI now distinguishes:
  - pipeline-empty (no classifications generated yet),
  - scope-empty (filters remove existing records).
- Cluster controls are disabled when no clusters exist, with explicit tooltip guidance.

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
