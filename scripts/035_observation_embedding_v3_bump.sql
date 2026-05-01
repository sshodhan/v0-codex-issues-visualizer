-- 035_observation_embedding_v3_bump.sql
--
-- Bumps observation_embedding algorithm version v2 -> v3. The
-- 2026-05-01 Phase 3 baseline snapshot showed singleton_rate=95.9%,
-- semantic-key share=3.9%, title-fallback share=96.1% — v2's
-- structured-prefix approach was not producing real semantic
-- groupings. The embedding pipeline was essentially producing one
-- cluster per title.
--
-- Root cause: v2 prepended bracketed [Type/Error/Component/Stack/
-- Platform] tags to title/body. The bracketed tags carried weak
-- signal because (a) `Type` (family_kind) is null for unclassified
-- clusters and only set after a cluster exists — chicken-and-egg,
-- so v2 ran with most rows missing Type, (b) Error/Stack/Platform
-- are sparse in a user-feedback corpus, and (c) the structured
-- signals had no LLM 4.a category/subcategory/tags input — the
-- richest available taxonomy was unused.
--
-- v3 changes:
--
--   * The helper that produces input text changes from
--     buildEmbeddingInputText (v2, lib/storage/semantic-cluster-core.ts)
--     to buildClassificationAwareEmbeddingText (v3,
--     lib/embeddings/classification-aware-input.ts) when
--     CURRENT_VERSIONS.observation_embedding === "v3".
--
--   * v3 emits signals in a tier-ordered structure matching the
--     user-feedback corpus signal hierarchy (PR #193's plan
--     amendment, "Corpus characteristics"):
--
--       Tier 1 (primary): Title, Summary, Topic, LLM 4.a Category,
--                          Subcategory, Tags (gated on confidence
--                          >= medium AND not review-flagged)
--       Tier 2 (secondary): Severity, Reproducibility, Impact,
--                            Confidence (gated on review-flagged only)
--       Tier 3 (supportive): Environment (collapsed
--                            cli=…/os=…/shell=…/editor=…/model=…),
--                            Error, Stack, Repro markers
--
--   * The collapse of the 6 fingerprint environment fields into one
--     Environment: line is the critical change vs v2. Sparse
--     environment values were over-anchoring unrelated reports
--     sharing one runtime value (e.g., both running gpt-4o).
--
--   * The production embedding pipeline fetches more upstream
--     signals than v2: full classifications row (Tier 1 + Tier 2),
--     classification_reviews (reviewer overrides + flag state),
--     complete bug_fingerprints (env fields + repro_markers count).
--     Source-of-truth for the row -> helper-input mapping is
--     helperInputFromRow in lib/embeddings/signal-coverage.ts (the
--     same function the Phase 2 admin metric uses).
--
--   * Algorithm version bumped so ensureEmbedding's
--     `algorithm_version = CURRENT_VERSIONS.observation_embedding`
--     filter no longer matches existing v1 / v2 rows. The next admin
--     rebuild call recomputes embeddings on demand for every
--     observation that goes through the pipeline. v1 / v2 rows
--     remain in observation_embeddings (unique constraint is per
--     algorithm_version) for replay integrity.
--
-- Cost: re-embedding ~487 observations at text-embedding-3-small is
-- ~$0.50 (price as of 2026-05). Latency ~500ms per uncached call;
-- batched embedding generation handles them inside the existing
-- admin-rebuild flow, so a full re-embed completes within the
-- route's 300s function timeout for corpora up to ~600 obs.
-- Larger corpora should re-embed in batches via the Phase 4 PR3
-- backfill UI (resumable, dry-run-first).
--
-- Stage 4a coverage co-requisite: as of 2026-05-01, only 16%
-- (78 / 487) of observations have classifications. v3 quality is
-- bounded by this — the remaining 84% will fall through
-- canUseTaxonomySignals and emit only Tier 1 minus LLM taxonomy.
-- Phase 4 PR3 MUST NOT trigger backfill until 4a coverage is pushed
-- to >= 80% via the existing classification admin tools. See
-- docs/CLASSIFICATION_EVOLUTION_PLAN.md Phase 4 §"Stage 4a / Stage 2
-- sequencing model".
--
-- Backfill / activation:
--
--   No data migration required — the v3 row simply becomes current.
--   To trigger v3 embeddings + re-clustering for the existing
--   corpus, push 4a coverage to >= 80% first, then open
--   /admin -> Layer A Clustering, select Semantic mode, tick
--   "Re-detach first", click Rebuild. Each observation will be
--   re-embedded under v3 (new row in observation_embeddings; old
--   v1 / v2 rows preserved), then re-clustered against the new
--   vector space.
--
-- Verification after rebuild:
--
--   select algorithm_version, count(*)
--     from observation_embeddings
--    group by 1
--    order by 1;
--   -- v3 row count should match the rebuild's `processed` total.
--
--   -- Run /api/admin/cluster-quality?days=0 again and append a new
--   -- row to the Phase 3 baseline snapshot table in the plan doc.
--   -- Compare singleton_rate / coherent_cluster_rate /
--   -- mixed_cluster_rate / semantic:% deltas against the 2026-05-01
--   -- baseline. Phase 5 dry-run is the formal evaluation; this is
--   -- the eyeball check.

begin;

update algorithm_versions
   set current_effective = false
 where kind = 'observation_embedding'
   and version = 'v2';

insert into algorithm_versions (kind, version, current_effective, notes) values
  (
    'observation_embedding',
    'v3',
    true,
    'Stage 2 embedding input v3: classification-aware tier-ordered text. Title -> Summary -> Topic -> LLM 4.a Category/Subcategory/Tags (gated on confidence >= medium AND not review-flagged) -> Tier 2 scalars (Severity/Reproducibility/Impact/Confidence, gated on review-flagged only) -> collapsed Environment line (cli/os/shell/editor/model) -> Error/Stack/Repro markers. Replaces v2 bracketed-prefix approach. Production wiring in recomputeObservationEmbedding dispatches to lib/embeddings/classification-aware-input.ts:buildClassificationAwareEmbeddingText with inputs assembled by lib/embeddings/v3-input-from-observation.ts. v1/v2 rows preserved for replay; v3 rows compute on-demand via ensureEmbedding when admin rebuild is triggered.'
  )
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
