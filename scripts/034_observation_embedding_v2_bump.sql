-- 034_observation_embedding_v2_bump.sql
--
-- Bumps observation_embedding algorithm version v1 -> v2. Production
-- diagnostic on 2026-04-30 found that of 417 active clusters, only 10
-- were `semantic:`-keyed and zero had > 1 member — the embedding
-- pipeline ran end-to-end but produced almost no real grouping at the
-- 0.86 cosine threshold.
--
-- Root cause: v1 embedded raw `Title: <title>\nSummary: <body>` only.
-- text-embedding-3-small returned vectors capturing surface-prose
-- similarity, not "are these the same kind of bug" similarity. Two
-- reports of the same root-cause CLI hang with different vocabularies
-- consistently scored below 0.86; two unrelated reports that shared
-- vocabulary ("Windows ACL handling") could score above. Threshold
-- tuning against this signal could not fix the misalignment.
--
-- v2 changes:
--   * buildEmbeddingInputText now prepends bracketed structured signals
--     when available BEFORE the existing title/summary text:
--       [Type: bug] [Error: TIMEOUT] [Component: codex-cli]
--       Title: <title>
--       Summary: <body>
--     Signals are sourced from existing tables already populated by
--     upstream stages — no new derivations required:
--       Type        ← family_kind (Stage 4 #2 family_classification)
--       Error       ← bug_fingerprints.error_code
--       Component   ← category_assignments.categories.slug (heuristic)
--       Stack       ← bug_fingerprints.top_stack_frame (truncated 60ch)
--       Platform    ← bug_fingerprints.os
--     Each tag is omitted when the underlying signal is null, so v2
--     gracefully degrades to v1's prose-only behavior on observations
--     that lack structured context.
--
--   * Algorithm version bumped so ensureEmbedding's
--     `algorithm_version = CURRENT_VERSIONS.observation_embedding`
--     filter no longer matches existing v1 rows. The next admin
--     rebuild call recomputes embeddings on demand for every
--     observation that goes through the pipeline. v1 rows remain in
--     observation_embeddings (unique constraint is per
--     algorithm_version) for replay integrity.
--
-- Cost: re-embedding 487 observations at text-embedding-3-small is
-- ~$0.50 (price as of 2026-04). Latency ~500ms per uncached call;
-- runSemanticClusteringForBatch handles them serially inside the
-- existing admin-rebuild flow, so a full re-embed completes within
-- the route's 300s function timeout for corpora up to ~600 obs.
-- Larger corpora should re-embed in batches via the same admin
-- panel's cursor pagination.
--
-- Backfill / activation:
--
--   No data migration required — the v2 row simply becomes current.
--   To trigger v2 embeddings + re-clustering for the existing corpus,
--   open /admin → Layer A Clustering, select Semantic mode, tick
--   "Re-detach first", click Rebuild. Each observation will be
--   re-embedded under v2 (new row in observation_embeddings; old v1
--   row preserved), then re-clustered against the new vector space.
--
-- Verification after rebuild:
--   select algorithm_version, count(*)
--     from observation_embeddings
--    group by 1
--    order by 1;
--   -- v2 row count should match the rebuild's `processed` total.
--
--   select avg(dominant_error_code_share) as avg_share,
--          count(*) filter (where dominant_error_code_share >= 0.999)
--             as perfect_clusters
--     from mv_cluster_health_current
--    where cluster_size >= 2;
--   -- avg_share should rise materially compared to the v1 baseline;
--   -- the admin panel's "Cluster quality" card surfaces this same
--   -- aggregate.

begin;

update algorithm_versions
   set current_effective = false
 where kind = 'observation_embedding'
   and version = 'v1';

insert into algorithm_versions (kind, version, current_effective, notes) values
  (
    'observation_embedding',
    'v2',
    true,
    'Stage 2 embedding input v2: prepend bracketed structured signals (Type/Error/Component/Stack/Platform) before Title/Summary so the embedding model encodes issue-type context, not just prose vocabulary. Addresses 2026-04 finding that v1 produced near-zero real clustering at default 0.86 threshold (10 of 417 clusters semantic-keyed; all clusters singleton-sized). v1 rows remain for replay; v2 rows compute on-demand via ensureEmbedding when admin rebuild is run.'
  )
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
