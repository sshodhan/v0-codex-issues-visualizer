# Classification Evolution Plan: Issue-Pattern Intelligence

## Goal

Evolve the system from row-level labeling into robust issue-pattern intelligence.

The objective is not only per-report classification accuracy; it is to transform noisy user reports into high-signal recurring issue families that support triage, prioritization, debugging, and product decisions.

## Core principle

Classification is a soft prior and quality lens for clustering, not a replacement for clustering.

## Hard invariants

- Stage 3 / Layer A remains the only layer that writes cluster membership.
- Taxonomy must not create cluster membership directly.
- Do not hard-partition clusters by Topic, LLM category, or subcategory.
- Do not mutate raw observations.
- Preserve append-only derivations and review records.
- Ingestion must not depend hard on OpenAI availability.
- LLM output must not silently override deterministic cluster membership.
- Every behavior change must be algorithm-versioned, dry-runnable, and auditable.

## PR feedback resolution checklist

This revision explicitly addresses review feedback by:

- Making phase gates stricter (no default behavior switch without evidence and rollback readiness).
- Calling out confidence/review-flag gating before LLM classification signals can influence embedding text.
- Separating read-time Layer B grouping from Stage 3 membership ownership in every relevant phase.
- Expanding dry-run-only requirements before any membership-affecting algorithm change.
- Keeping schema evolution additive for family/review layers and preserving append-only history.

## Current system summary

- Raw evidence: `observations`, `observation_revisions`, `engagement_snapshots`, `ingestion_artifacts`.
- Stage 1 / Layer 0 deterministic enrichment: Topic (`CATEGORY_PATTERNS`), `category_assignments`, sentiment, impact, competitor mentions, bug fingerprints.
- Stage 2 embeddings: `observation_embeddings`.
- Stage 3 / Layer A semantic clusters: `clusters`, `cluster_members`, semantic clustering + deterministic fallback.
- Stage 4a per-observation LLM classification: taxonomy/prompt/schema + `classifications` (+ review state).
- Layer B triage grouping: read-time grouping by `effective_category + effective_subcategory` (not membership).
- Stage 4b family classification: `family_classifications`, `family_classification_current`, family fields.
- Stage 4c cluster labels: `clusters.label`, `label_confidence`, `label_model`, `label_rationale`.
- Stage 5 human review: `classification_reviews`, `topic_review_events`, `family_classification_reviews`.

---

## Corpus characteristics

This system processes **user feedback reports**, not stack-trace-driven crash data. That difference dictates which signals are high-value for grouping similar reports and which are merely supportive context. Every phase that touches embedding input, similarity scoring, or cluster validation MUST treat the hierarchy below as a foundational assumption — drift away from it (e.g., weighting a sparse environment field as a peer of LLM category) is a known root cause of the singleton / over-merge failure modes.

### Signal value hierarchy

| Tier | Signals | Why |
|---|---|---|
| **Primary (high signal)** | Title, Body / Summary, regex Topic (Stage 1 / Layer 0), LLM 4.a Category / Subcategory / Tags (when confidence ≥ medium and not review-flagged), reviewer-corrected category/subcategory | These are what the *user* and the *trusted classifier* say the issue is about. They carry meaningful semantic content for grouping reports about the same recurring problem. |
| **Secondary (medium signal)** | LLM 4.a Severity, Reproducibility, Impact | Honest scalar self-reports about the report. Useful disambiguation but rarely the primary anchor. |
| **Tertiary (supportive only)** | Bug fingerprint fields — `error_code`, `top_stack_frame`, `cli_version`, `os`, `shell`, `editor`, `model_id`, `repro_markers` | Sparse in user-feedback corpus (most reports lack them). When present, they're useful tiebreakers — but each individual field is a literal-match anchor that can over-merge two unrelated reports that happen to share an environment value. Treat as a *single collapsed `Environment` signal*, not as N independent peers. |

### What this implies, by phase

- **Phase 1 (embedding text builder)**: emit Tier 1 first, then Tier 2, then a single collapsed `Environment` line summarizing Tier 3 — never N separate fingerprint lines that compete with high-value structured signals for embedding-space attention. See Phase 1 §"Implementation tasks" below.
- **Phase 4 (v3 generation)**: the helper reshape that enacts the above is the first commit.
- **Phase 5 (dry-run comparison)**: the diff output MUST flag merges driven solely by fingerprint match as a suspicious-merge category, so Phase 6 has evidence to weight fingerprint correctly.
- **Phase 6 (soft-prior scoring)**: `fingerprint_match_bonus` MUST be smaller than `category_match_bonus` / `subcategory_match_bonus` / `topic_match_bonus`. It's a tiebreaker that nudges already-similar reports together, not a peer signal that merges otherwise-different reports. See Phase 6 §"Scoring helper" below.

### What this is NOT

- This hierarchy applies to **embedding text and similarity scoring**. It does not change Stage 4a's classification prompt (which already uses title + body) or Stage 4b's family interpretation (which reads cluster contents holistically).
- Tier 3 is not "useless" — when LLM 4.a is unavailable or low-confidence and Stage 1 Topic is missing, the collapsed Environment line is the *only* structured signal a report carries. The helper still emits it; it just doesn't get top-billing.
- The hierarchy does not justify dropping Tier 3 from the embedding text. The point is *placement and shape*, not omission.

---

## PHASE 0 — Code-grounded system map

### Goal
Document the current system before behavior changes.

### Current System Map

| Layer / Stage | Definition source | Storage | Unit | Writer | Consumers | Creates cluster membership? |
|---|---|---|---|---|---|---|
| Raw evidence | Scrapers/providers + ingestion | `observations`, `observation_revisions`, `engagement_snapshots`, `ingestion_artifacts` | Per-observation | Ingestion | All downstream | No |
| Stage 1 / Layer 0 deterministic enrichment | `lib/scrapers/shared.ts` (`CATEGORY_PATTERNS`), fingerprint extractors | `category_assignments`, `categories.slug`, derived fields | Per-observation | Enrichment + backfill derivations | Topic filters, label fallback, topic metadata/review | No |
| Stage 2 embeddings | Embedding builder + algorithm selector | `observation_embeddings` | Per-observation | Embedding jobs/rebuilds | Stage 3 clustering | No |
| Stage 3 / Layer A clustering | `lib/storage/semantic-cluster-core.ts`, `lib/storage/semantic-clusters.ts` | `clusters`, `cluster_members` | Per-cluster + membership edge | Cluster rebuild/admin route | Cluster/family APIs/UI | **Yes (only layer)** |
| Stage 4a LLM classification | `lib/classification/taxonomy.ts`, `prompt.ts`, `schema.ts` | `classifications`, `classification_reviews` | Per-observation | Classification pipeline + review events | Triage, story drawer, stats | No |
| Layer B triage grouping | Effective state resolution (`effective_category`, `effective_subcategory`) | Read-time grouping | Read-time | Query-time | Classification triage UI/API | No |
| Stage 4b family classification | Family prompt/schema/storage helpers | `family_classifications`, `family_classification_current` | Per-cluster | Family backfill/admin actions | Family/admin quality surfaces | No |
| Stage 4c cluster labels | Label fallback ladder/backfill/manual override | `clusters.label`, `label_model`, `label_confidence`, `label_rationale` | Per-cluster | Label backfill/manual override | Layer A Labels/admin/dashboard | No |
| Stage 5 human review | Review routes and append-only records | `classification_reviews`, `topic_review_events`, `family_classification_reviews` | Per-review event | Reviewer/admin actions | Effective state + QA traces | No |

### Required trace points

1. **Stage 1 Topic**
   - Defined in `lib/scrapers/shared.ts` (`CATEGORY_PATTERNS`).
   - Written through deterministic enrichment and stored in `category_assignments` / `categories.slug` linkage.
   - Read by dashboard topic filters, deterministic cluster-label fallback, cluster topic metadata, and topic review/admin flows.

2. **Stage 4a LLM classification**
   - Defined in `lib/classification/taxonomy.ts`; prompt in `lib/classification/prompt.ts`; validation in `lib/classification/schema.ts`.
   - Written to `classifications`; corrected/overridden via `classification_reviews` (append-only review layer).
   - Read by Layer B grouping/filter logic, classification-triage UI, story/signal surfaces, and stats APIs.

3. **Stage 2 embeddings**
   - Produced by embedding text builder + model/version selection.
   - Stored in `observation_embeddings` with algorithm version.
   - Read by Stage 3 clustering jobs and rebuild endpoints.

4. **Stage 3 membership**
   - Created only by semantic clustering + deterministic fallback clustering.
   - Stored in `clusters` and `cluster_members`.
   - Read by cluster APIs, dashboard cluster/family views, and label/family derivations.

5. **Stage 4b family classification**
   - Created via family classification pipeline/admin panel.
   - Stored in `family_classifications` and `family_classification_current`.
   - Reads cluster members; writes per-cluster interpretation (`family_kind`, `family_title`, `family_summary`, confidence/review fields).

6. **Stage 4c cluster labels**
   - Created by label backfill/manual override + deterministic fallback ladder.
   - Stored in `clusters.label`, `label_model`, `label_confidence`, `label_rationale`.
   - Surfaced in Layer A Labels admin tab and cluster-facing UI.

7. **Layer B grouping**
   - Exists as read-time grouping by `effective_category + effective_subcategory`.
   - Explicitly **not** cluster membership.

### Where `lib/classification/taxonomy.ts` is applied today

- It defines the Stage 4a per-observation category/subcategory space and supports classification prompting/validation.
- It powers read-time grouping/filtering and triage analytics.
- It does **not** write `cluster_members`.

### Target Semantics

Definitions:

- Topic = deterministic Layer 0 label for filtering/lightweight evidence.
- LLM category/subcategory = Stage 4a per-observation failure taxonomy.
- Semantic cluster / Family = Stage 3 actual membership grouping.
- Family classification = Stage 4b cluster interpretation and coherence validation.
- Cluster label = Stage 4c display label / fallback name.
- Layer B triage group = read-time grouping by `effective_category + effective_subcategory`.

Required invariant:

> Only Stage 3 writes cluster membership. Taxonomy can guide, explain, and validate clustering, but taxonomy does not directly create cluster membership.

### Exit criteria

- No runtime behavior changes.
- Layer ownership and taxonomy application points are explicit.
- Reviewer can answer: “Which layer caused this label/family/grouping?”

---

## PHASE 1 — Classification-aware embedding input v3 (dry-run only)

### Goal
Add a pure, versioned formatter that combines raw text and structured signals without changing default clustering behavior.

### Implementation tasks

- Add helper module (example): `lib/embeddings/classification-aware-input.ts`.
- Implement `buildClassificationAwareEmbeddingText(input)`.

Input fields, grouped by the corpus signal hierarchy (see [Corpus characteristics](#corpus-characteristics) for the full rationale):

**Tier 1 — primary signals (high value, emit first):**
- raw title
- raw body / summary / content
- Stage 1 / Layer 0 Topic (regex-derived; deterministic)
- Stage 4a LLM classification — category, subcategory, tags (gated: confidence ≥ medium and not review-flagged)

**Tier 2 — secondary signals (medium value, emit after Tier 1):**
- Stage 4a LLM severity, reproducibility, impact (always emit when present, no confidence gate — they are honest scalar self-reports)
- LLM confidence bucket itself (informational; helps the model down-weight low-confidence neighbors)

**Tier 3 — supportive context (low value, emit LAST as a single collapsed line):**
- Bug fingerprint fields: `error_code`, `top_stack_frame`, `cli_version`, `os`, `shell`, `editor`, `model_id`, `repro_markers`
- These collapse into a single `Environment: cli=… os=… editor=… model=…` line. `error_code` and `top_stack_frame`, when present, get their own lines AFTER the Environment line.
- Rationale: user-feedback corpus has sparse fingerprint data. Emitting each field as a separate line creates literal-match anchors that over-merge unrelated reports sharing one environment value (e.g., two unrelated bugs both running `model=gpt-4o`).

Rules:

- Raw title/body always present.
- Omit missing fields entirely (no placeholder text).
- Do not insert fake "unknowns" — `unknown` strings filtered out so they can't act as a shared sentinel.
- Exclude long `evidence_quotes` from embedding text.
- Sort tags deterministically (ASCII order, deduplicated).
- Include LLM category/subcategory/tags only if confidence is sufficient and row is not review-flagged.
- If low-confidence/review-flagged, omit LLM category/subcategory/tags from embedding text (raw text + Topic + Tier 3 still emitted).
- Prefer reviewer-corrected category/subcategory when computing effective classification for backfills.
- **Order within the emitted text follows the tier hierarchy above**: Title → Summary → Topic → LLM Category/Subcategory/Tags → Severity/Reproducibility/Impact/Confidence → Environment (collapsed) → Error / Stack / Repro markers (only when present).
- **Fingerprint fields collapse into one `Environment` line.** Do not emit individual `CLI:` / `OS:` / `Shell:` / `Editor:` / `Model:` lines.

Tests:

- deterministic ordering — pinned to the tier hierarchy
- missing fields omitted (no placeholders, no empty labels)
- tags sorted deterministically
- low-confidence LLM fields omitted
- review-flagged LLM fields omitted
- raw title/body always present (even when every other signal is missing)
- evidence_quotes excluded
- reviewer override preferred over LLM category/subcategory
- **Tier ordering pinned**: a row with all signals present produces them in the documented order; reordering inputs does NOT change output order
- **Environment collapse pinned**: a row with N fingerprint fields produces one `Environment:` line, not N individual lines

### Exit criteria

- Helper is pure and tested.
- Existing embedding path unchanged.
- Preview text generation works.
- No cluster membership changes.

---

## PHASE 2 — Embedding signal coverage and preview tooling

### Goal
Measure structured-signal availability before generating v3 embeddings.

### Tasks

Add dry-run report or admin/debug endpoint with metrics:

- total observations
- with Stage 1 Topic
- with bug fingerprint
- with any LLM classification
- with high-confidence LLM classification
- with review-flagged LLM classification
- with usable category/subcategory/tags
- that would fall back to raw-only
- distribution by LLM category/subcategory
- distribution by Topic

Optional per-observation preview:

- raw embedding text
- classification-aware embedding text
- included fields
- omitted fields + reasons

### Exit criteria

- Coverage shows whether v3 signal is materially different from raw-only.
- Low-confidence/review-flagged exclusions are visible.
- No default behavior changes.

### Decision gate
Proceed only if structured signals are sufficiently present and not dominated by low-confidence/flagged classifications.

---

## PHASE 3 — Cluster quality metrics (no behavior change)

### Goal
Capture baseline clustering quality before behavior changes.

### Primary KPIs

1. `coherent_cluster_rate`
2. `singleton_rate`
3. `mixed_cluster_rate`

#### Concrete definitions (locked in PR #192)

The plan's original prose definitions left ambiguities (which threshold? which denominator? which clusters count?). Below is the exact formula every consumer (the metric, the UI, Phase 6's experiment, Phase 11's go-live gate) reads. The mixed-cluster threshold is centralized as a single constant in `lib/cluster-quality/baseline-metrics.ts` so a future re-tune happens in one place.

| KPI | Numerator | Denominator | Threshold |
|---|---|---|---|
| `coherent_cluster_rate` | clusters with `family_classification_current.family_kind = 'coherent_single_issue'` | clusters that have a row in `family_classification_current` OR `family_classification_review_current` | n/a |
| `singleton_rate` | active clusters with exactly 1 active member (`size_in_window = 1`) | total active clusters (any cluster with ≥ 1 active member) | n/a |
| `mixed_cluster_rate` | multi-member classified clusters where the dominant LLM category share < `MIXED_CLUSTER_THRESHOLD` | multi-member clusters with at least one classified observation | `MIXED_CLUSTER_THRESHOLD = 0.5` |

Notes:
- `singleton_rate` uses **active** members only — clusters with all members detached don't count toward either numerator or denominator. This matches the `cluster_path_distribution` card already on `/admin`.
- `mixed_cluster_rate` denominator is **multi-member classified** — a singleton can't be "mixed", and an unclassified cluster can't be evaluated for mixedness. Reporting it over all clusters would mix two different concerns.
- The threshold value is captured here so a future re-tune is one edit, not a search-and-replace.

### Diagnostic metrics

All metrics below are surfaced by the Phase 3 endpoint and rendered in the admin panel. Each has a code-level test that locks its definition.

- `total_clusters` (active only — at least one undetached member)
- `semantic_clusters` (cluster_key prefix `semantic:`)
- `deterministic_fallback_clusters` (cluster_key prefix `title:`)
- `multi_member_clusters`
- `singleton_rate_by_category` (Map: heuristic Topic slug → singleton rate)
- `singleton_rate_by_subcategory` (Map: LLM subcategory → singleton rate)
- `multi_member_clusters_by_category`
- `multi_member_clusters_by_subcategory`
- `dominant_category_share_distribution` (histogram: [<0.5, 0.5-0.7, 0.7-0.9, 0.9-1.0] over multi-member classified clusters — this is how the plan's "dominant share per cluster" requirement is satisfied: each multi-member classified cluster lands in exactly one bucket, and the bucketed view scales to thousands of clusters where a per-row table would not)
- `mixed_category_clusters` (count where dominant LLM category share < threshold)
- `mixed_subcategory_clusters` (count where dominant LLM subcategory share < threshold)
- `top_mixed_topic_clusters` (top-N drill-down by `mv_cluster_topic_metadata.mixed_topic_score` — the per-cluster spot-check surface for the over-merged regime)
- `family_classification_coverage` (clusters with a `family_classification_current` row / total clusters)
- `coherent_family_rate` (`family_kind = 'coherent_single_issue'` / classified clusters)
- `split_needed_family_rate` (`family_kind = 'mixed_multi_causal'` / classified clusters)
- `review_disagreement_rate` (`family_classification_review_current` rows where `actual_family_kind != expected_family_kind` / total reviewed clusters; null when no reviews exist)

### Phase 3 success thresholds (locked — accepted in PR #192 review)

These are the numbers Phase 6's soft-prior experiment and Phase 11's go-live gate will be measured against. **Status: accepted by the repo owner in PR #192 review.** Any later phase that wants to revise a threshold must (a) propose the change in a PR that edits this table, (b) cite measurement evidence (not feels), and (c) get explicit acceptance — the same protocol used here.

| Phase 6 / Phase 11 outcome | Threshold |
|---|---|
| **Win** — `singleton_rate` improvement | must drop by ≥ 5 percentage points (e.g., 90% → 85%) |
| **No-regress** — `mixed_cluster_rate` | must NOT rise by more than 2 percentage points |
| **Win** — `coherent_cluster_rate` improvement | must rise by ≥ 3 percentage points OR stay flat with documented qualitative improvement (manual spot-check of 10+ representative clusters) |
| **Operational gate** — rollback path | must be exercised end-to-end at least once (no rebuild in production has rolled back without operator intervention as of baseline) |

Tuning rationale (kept for future reviewers): with the current corpus singletons dominate (per PR #186 / PR #191 diagnostics), so a 5pp improvement is meaningful but achievable. A 2pp mixed-cluster regression cap accepts that some merging will surface mixed clusters that were singletons before — the question is whether they're truly mixed or just under-coherent. The 3pp coherent-rate win is generous because family classification coverage is currently low (~15% per the v2 diagnostic) — most clusters can't even be evaluated for coherence today.

### Exit criteria

- All KPIs and diagnostics computable via a single admin endpoint without clustering behavior changes.
- Baseline numbers recorded in this plan (see [Phase 3 baseline snapshot](#phase-3-baseline-snapshot) below — populated post-merge by running the endpoint against production).
- Dashboard panel can identify singleton-heavy, over-merged (high mixed-cluster rate), and fallback-heavy (high `title:` share) regimes.
- Phase 6 success thresholds locked above.

### Decision gate
**Phase 4 is BLOCKED until both of the following are true:**
1. The baseline snapshot table below has at least one populated row (not "TBD"), recorded against production by running `GET /api/admin/cluster-quality?days=0`. Phase 4 work MUST NOT start before this commit lands. The PR that adds the snapshot row is the gate; merging the Phase 3 endpoint alone does not unblock Phase 4.
2. The success thresholds in the table above remain locked (no in-flight revision PR) — or, if a revision is proposed, it has been accepted before any Phase 4 work begins.

### Phase 3 baseline snapshot

**Canonical baseline mode**: `GET /api/admin/cluster-quality?days=0` (all-time). The 7 / 30 / 90-day windows surfaced in the admin panel are diagnostic drift views only — they show how recent activity compares to the full corpus. The snapshot row pasted into the table below MUST come from `days=0`; do not snapshot a windowed view.

> Populated post-merge by running `GET /api/admin/cluster-quality?days=0` against production and pasting the CSV row below. Add new snapshot rows as the corpus grows; never edit historical rows so we preserve a time series to compare against.

| Recorded | total_clusters | singleton_rate | coherent_cluster_rate | mixed_cluster_rate | family_coverage | semantic:% | title:% |
|---|---|---|---|---|---|---|---|
| YYYY-MM-DD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

---

## PHASE 4 — Classification-aware embedding generation (versioned, opt-in)

> **Prerequisite gate (do not start Phase 4 until satisfied):** the Phase 3 baseline snapshot table must have a populated row (not "TBD") and the locked Phase 6 / Phase 11 thresholds must still be accepted. See [Phase 3 decision gate](#decision-gate) above.

### Goal
Generate v3 embeddings without making them default for clustering.

### Tasks

- Add embedding algorithm version (e.g., `observation_embedding_v3`).
- Versioned append-only writes to `observation_embeddings`.
- Preserve raw-only path.
- Ensure v3 text is reproducible from versioned config/evidence.
- Support dry-run then explicit apply.

Backfill/admin action behavior:

- dry-run count
- append-only apply
- resumable
- skip already v3-embedded rows
- record algorithm version

Tests:

- version selection
- skip already-embedded
- fallback when classification missing
- no hard failure when LLM unavailable
- formatter stability

### Exit criteria

- v3 generation works append-only and replayably.
- v1/v2 preserved.
- No cluster membership changes.

### Decision gate
Proceed only if v3 coverage is sufficient and nearest-neighbor spot checks are neutral/better.

---

## PHASE 5 — Dry-run clustering comparison

### Goal
Compare current clustering vs v3-embedding clustering without production writes.

### Tasks

Add dry-run comparison output:

- clusters created/merged/split
- singleton delta
- multi-member delta
- mixed-category delta
- dominant share deltas
- improved merge examples
- suspicious over-merge examples — **must include a `fingerprint_only_merge` flagged subset**: merges where the only shared structured signal is fingerprint (no shared Topic, no shared LLM category/subcategory). This is the empirical check that the Tier 3 demotion (see [Corpus characteristics](#corpus-characteristics)) holds in practice. If the flagged subset is large, Phase 6 must lower `fingerprint_match_bonus` further before enabling.
- lost-good-cluster examples
- representative member lists

Do not:

- write `cluster_members`
- mutate `clusters`
- update labels
- switch defaults

### Exit criteria

- Readable, inspectable diff output.
- No production membership changes.

### Success gate
Proceed only if singleton improves, mixed does not materially worsen, and suspicious merges are rare/explainable.

---

## PHASE 6 — Soft-prior clustering experiment (algorithm-versioned)

### Goal
Implement classification as soft prior in similarity scoring.

### Scoring helper

```text
final_similarity =
  semantic_similarity
  + category_match_bonus       (Tier 1 — primary)
  + subcategory_match_bonus    (Tier 1 — primary)
  + tag_overlap_bonus          (Tier 1 — primary)
  + topic_match_bonus          (Tier 1 — primary)
  + fingerprint_match_bonus    (Tier 3 — TIEBREAKER ONLY)
  - category_conflict_penalty
```

Hard rules:

- taxonomy alone never merges
- low semantic similarity never merges
- very high semantic similarity can cross categories
- same category/subcategory lowers threshold modestly
- different category raises evidence threshold modestly
- low-confidence/review-flagged classification contributes little/no bonus
- **`fingerprint_match_bonus` is a Tier 3 tiebreaker, not a peer of category/subcategory/topic bonuses.** Numerically: `fingerprint_match_bonus` MUST be smaller (recommended: ≤ 1/3) than any Tier 1 bonus. Rationale: in a user-feedback corpus, two reports sharing `model=gpt-4o` is weak evidence they're the same issue, while two reports sharing `category=auth` + `subcategory=2fa-failure` is strong evidence. See [Corpus characteristics](#corpus-characteristics).
- The fingerprint bonus should only fire when at least 2 fingerprint fields match (single-field match is too weak to merit a bonus).

Suggested threshold bands:

- `semantic_similarity >= high_threshold`: can merge across categories unless strong conflict
- `semantic_similarity >= medium_threshold`: merge only with supportive structured signals
- `semantic_similarity < low_threshold`: never merge

Tests:

- incremental bonuses/penalties
- confidence-sensitive weighting
- cross-category high-similarity allowance
- low-similarity no-merge guard
- generic-tag anti-overboost checks

Run behind algorithm version + feature flag + dry-run first.

### Exit criteria

- Helper is pure and tested.
- Dry-run comparison exists.
- Production unchanged unless explicitly enabled.

### Decision gate
Do not enable by default until baseline is beaten.

---

## PHASE 7 — Family classification as cluster validator

### Goal
Shift family classification from naming to coherence validation.

### Required questions

- Is this a coherent recurring issue pattern?
- Are members likely the same issue?
- Is it too broad/multi-causal?
- Does it need split review?
- What evidence supports vs weakens grouping?
- What representative title should be shown?

Desired fields:

- `family_kind`: `coherent_single_issue | mixed_multi_causal | needs_split_review | low_evidence | unclear`
- `family_title`
- `family_summary`
- `representative_observation_ids`
- `evidence_for_grouping`
- `evidence_against_grouping`
- `suggested_split_hints`
- `needs_human_review`
- `review_reasons`
- `confidence`

If unsupported, add additive migration (no destructive replacement).

Tests:

- coherence-state classification cases
- split-needed detection
- low-evidence behavior
- conflicting-subcategory handling
- safety rules preventing unsafe silent overrides

### Exit criteria

- Family classification acts as validator.
- Evidence fields captured/planned.
- No membership mutation.

---

## PHASE 8 — Reviewer feedback for cluster quality

### Goal
Collect clustering-quality feedback separately from row-classification feedback.

### Tasks

Design append-only cluster/family review events with outcomes:

- `correct_family`
- `too_broad`
- `too_narrow`
- `wrong_group`
- `same_symptom_different_root_cause`
- `same_root_cause_different_wording`
- `wrong_family_title`
- `insufficient_context`
- `should_merge_with_cluster_id`
- `should_split_by_reason`
- `reviewer_notes`

Rules:

- append-only
- no immediate membership mutation
- feedback informs future tuning/backfills
- review UI should show: raw observation, Topic, embedding version, cluster membership, LLM classification, family classification, prior reviews

### Exit criteria

- Schema/API/UI design implemented or fully specified.
- Distinguishes classification errors vs clustering errors.
- No automatic split/merge yet.

---


## PHASE 9 — Admin screen integration + Cross-layer Observation Trace

### Goal
Ensure each new signal and metric is visible in existing admin surfaces and that reviewers can trace an observation across layers end-to-end.

### Admin surfaces to wire and verify

### Existing admin screens (from current UI)

Current admin tabs/surfaces that this plan must map to:

- `Layer 0 Backfill`
- `Layer C Backfill`
- `Layer A Clustering`
- `Cross-layer Trace`
- `Stage 5: Topic Review`
- `Schema / Contracts`
- `Layer A Labels`
- `Family Classification`

Implementation rule: every new field/metric/log in Phases 1–8 must declare **which tab displays it** and **which API payload carries it** before rollout gate approval.

- **Admin cluster rebuild screen** (`app/api/admin/cluster/route.ts` + related UI):
  - show embedding algorithm version used
  - show classification-aware embedding coverage stats (when run)
  - show dry-run comparison summaries
- **Layer A Labels admin tab**:
  - display label source/fallback rung and label confidence
  - show whether cluster label changed across algorithm versions
- **Family classification admin panel** (`components/admin/family-classification-panel.tsx` + APIs):
  - show family coherence fields/status when available
  - show review-needed reasons and reviewer disagreement indicators
- **Topic review admin screens**:
  - preserve deterministic Topic provenance and review history
- **Classification triage/admin screens**:
  - keep Layer B grouping explicit as read-time only (never membership)

### Cross-layer Observation Trace requirements

Add/verify a trace view that can answer, for any observation and cluster (matching existing cards such as Capture, Bug fingerprint, Embedding, Topic):

1. Raw observation evidence (`observations` + revision context)
2. Stage 1 Topic + deterministic signals/fingerprints
3. Stage 2 embedding version + input mode (raw vs classification-aware)
4. Stage 3 current and historical cluster membership edges
5. Stage 4a baseline classification + effective override state
6. Layer B grouping (`effective_category` + `effective_subcategory`) as read-time only
7. Stage 4b family classification/coherence interpretation
8. Stage 4c cluster label source/fallback rationale
9. Stage 5 review events timeline (classification/topic/family/cluster reviews)

Trace constraints:

- Append-only timeline semantics
- Algorithm-version stamps on derivations
- Explicit distinction between evidence, derivation, interpretation, and review
- Exportable debug payload for incident review

### Observability/log events for admin + trace

- `embedding_rebuild_started|batch_completed|completed`
- `embedding_signal_coverage_summary`
- `cluster_rebuild_started|batch_completed|completed`
- `classification_soft_prior_dry_run_started|completed`
- `family_validation_started|completed|quality_summary`
- `cluster_review_recorded|classification_review_recorded|topic_review_recorded`
- `cross_layer_trace_viewed` (optional, for audit/usage)


### Admin mapping checklist (required before default switch)

- Phase 1/2 embedding input + coverage: visible in `Layer A Clustering` and per-observation `Cross-layer Trace` Embedding card.
- Phase 3 coherence metrics: visible in `Layer A Clustering` quality panel and drill-through links to `Family Classification`.
- Phase 4 embedding version rollout: version and model visible in Embedding card + cluster rebuild summaries.
- Phase 5/6 dry-run comparisons: visible in `Layer A Clustering` as non-mutating diff output with risky merge samples.
- Phase 7 validator fields: visible in `Family Classification` and reflected in trace panel as Stage 4b output.
- Phase 8 reviewer feedback: visible in `Family Classification` + trace timeline with append-only ordering.
- Layer ownership badges visible in trace (`Stage 3 writes membership`, `Layer B read-time only`).

### Exit criteria

- All required admin screens display new phase artifacts without ambiguity.
- Reviewer can open one trace view and identify failure source layer (Topic vs classification vs embedding vs clustering vs family label/review).
- Layer B is visibly marked read-time grouping only.
- No new writes to membership from admin visualization flows.

---


## PHASE 10 — Signals screen integration (Signal cloud in time)

### Goal
Integrate new clustering/classification artifacts into the Signals screen so quality changes are visible in the primary analyst workflow, not only admin tabs.

### Target screen

`Signal cloud in time` view (topic/family/label/cluster coloring toggle).

### Integration requirements

- Add explicit data-contract mapping for each coloring mode:
  - **Topic**: Stage 1 deterministic Topic (`category_assignments`/`categories.slug`) only.
  - **Family**: Stage 4b family classification output (`family_classification_current`) when available.
  - **Label**: Stage 4c cluster label (`clusters.label`) with fallback-rung metadata.
  - **Cluster**: Stage 3 cluster membership identity (`cluster_members`/`clusters`).
- Add legend annotations that disclose source layer and algorithm version where relevant.
- For each dot, expose drill-through to Cross-layer Trace with observation id + active cluster id.
- Ensure weekends/date bands and impact sizing continue to use existing semantics (no silent scoring changes in this phase).
- Add explicit visual indicator when a dot is `unlabeled` due to missing Stage 4b/4c outputs (not membership missing).

### Quality overlays (read-only diagnostics)

Optional overlays/toggles in Signals screen:

- highlight singletons vs multi-member clusters
- highlight mixed-category/mixed-subcategory clusters
- show family coherence status badges when mode = Family
- filter to `needs_split_review` / `low_evidence` families

These overlays must be read-only and must not mutate cluster membership.

### API/data requirements

- Add/extend API payload to include:
  - `cluster_id`
  - `cluster_algorithm_version`
  - `topic_slug`
  - `family_kind` / coherence status (if available)
  - `cluster_label` + `label_confidence` + label source/fallback rung
  - `is_singleton` and optional dominant-share diagnostics
- Keep payload backward compatible for existing chart rendering.

### Tests

- Topic/Family/Label/Cluster toggle uses correct source layer.
- Unlabeled state renders when family/label missing.
- Drill-through opens Cross-layer Trace with correct ids.
- Overlay flags are read-only and do not trigger write endpoints.
- Backward compatibility for existing signals payload consumers.

### Exit criteria

- Signals screen can explain each rendered color/grouping by layer source.
- Analysts can pivot from any signal dot into Cross-layer Trace.
- No mutation side effects from Signals interactions.
- Layer semantics remain consistent with Stage 3 membership ownership.

---

## PHASE 11 — Controlled rollout

### Rollout order

1. Docs/system map
2. Embedding input formatter
3. Coverage report
4. Cluster metrics baseline
5. v3 embedding generation
6. Dry-run clustering comparison
7. Soft-prior clustering experiment
8. Family validator improvements
9. Reviewer feedback loop
10. Admin + Cross-layer Observation Trace verification
11. Signals screen integration verification
12. Default switch only after metrics pass

### Default-switch criteria

- `singleton_rate` improves
- `mixed_cluster_rate` does not worsen
- reviewed samples show better recurring families
- `coherent_cluster_rate` improves or is expected to improve with reviewed evidence
- rollback path exists
- previous algorithm remains available
- rebuild/backfill remains explicit and operator-driven

---

## Global acceptance criteria

We can answer:

1. Are recurring issue patterns grouped better?
2. Did singleton rate decrease inside high-confidence category/subcategory neighborhoods?
3. Did mixed-category over-merges stay flat or decrease?
4. Do family classifications mark more clusters as `coherent_single_issue`?
5. Can reviewers locate failure source (Topic vs taxonomy vs embedding input vs merge/split vs family title)?
6. Can we replay old vs new by algorithm version?
7. Can every cluster be explained via members, similarity/fingerprint signals, classification distribution, family rationale, and review feedback?

## Non-goals

- Do not replace Stage 3 with taxonomy grouping.
- Do not hard-partition by category/subcategory.
- Do not remove deterministic fallback clustering.
- Do not collapse Topic and LLM category into one space.
- Do not use family title as membership source.
- Do not mutate raw/historical evidence.
- Do not make ingestion fail when OpenAI is unavailable.

---

## Verification flow (end-to-end)

```text
Raw public report
  ↓
Evidence layer
  observations / observation_revisions / engagement_snapshots / ingestion_artifacts
  immutable source of truth
  ↓
Stage 1 — Deterministic enrichment
  Topic taxonomy
  sentiment
  impact
  competitor mentions
  bug fingerprints
  error_code / stack / platform / version / repro markers
  ↓
Stage 4a — Per-observation LLM classification, moved earlier as usable signal
  category
  subcategory
  severity
  status
  confidence
  reproducibility
  impact
  tags
  evidence_quotes
  reviewer override if available
  ↓
Stage 2 — Classification-aware embeddings
  observation_embeddings v3
  raw title/body
  + Topic
  + bug fingerprints
  + LLM category/subcategory/tags
  + confidence/repro/impact signals
  with low-confidence/review-flagged fields gated or omitted
  ↓
Stage 3 — Issue-family clustering
  clusters
  cluster_members
  actual cluster membership / “Family” membership
  semantic similarity
  + classification soft-prior scoring
  + fingerprint support
  + deterministic fallback
  ↓
Layer B — Triage grouping, still read-time only
  effective_category + effective_subcategory
  taxonomy navigation / filtering
  not cluster membership
  ↓
Stage 4b — Per-cluster family classification as validator
  family_kind
    coherent_single_issue
    mixed_multi_causal
    needs_split_review
    low_evidence
    unclear
  family_title
  family_summary
  confidence
  evidence_for_grouping
  evidence_against_grouping
  suggested_split_hints
  needs_human_review
  review_reasons
  ↓
Stage 4c — Cluster label / family-name display fallback
  clusters.label
  label_confidence
  label_model
  label_rationale
  fallback ladder:
    family_title → clusters.label → Cluster #short-id
  ↓
Stage 5 — Human review and learning loop
  classification_reviews
  topic_review_events
  family_classification_reviews
  cluster/family quality review events
    correct_family
    too_broad
    too_narrow
    wrong_group
    should_merge
    should_split
    wrong_family_title
  ↓
Improvement loop
  reviewer feedback informs:
    Topic regex tuning
    LLM taxonomy / prompt edits
    embedding input design
    soft-prior scoring weights
    clustering thresholds
    family validator prompt
```

### Verification intent

- This flow is the required verification checklist when validating phase completion.
- It makes ownership boundaries explicit (especially Stage 3 membership ownership and Layer B read-time-only semantics).
- It should be reflected consistently in Admin tabs, Cross-layer Trace, and Signals screen drill-throughs.
