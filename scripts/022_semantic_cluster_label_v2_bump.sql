-- 022_semantic_cluster_label_v2_bump.sql
--
-- Flips `semantic_cluster_label` from v1 → v2 in the algorithm_versions
-- registry to match the runtime constant in
-- `lib/storage/algorithm-versions.ts` (CURRENT_VERSIONS) and the schema
-- verifier's manifest (`lib/schema/expected-manifest.ts`).
--
-- Why this exists
--   PR fed4ea6 ("feat(clusters): deterministic Topic+error fallback")
--   bumped the labelling pipeline v1 → v2:
--     * Prompt grew dominant Topic + recurring error codes.
--     * Small-→-large model escalation mirroring the classifier.
--     * Deterministic Topic+error fallback in
--       lib/storage/cluster-label-fallback.ts so every cluster has a
--       displayable label.
--   The TS constant flipped to v2 and the schema manifest expects v2,
--   but no SQL companion was shipped. Result: the live registry still
--   has `current_effective = true` on the v1 row, so the admin
--   schema-verifier surfaces a v1/v2 drift even though the running code
--   IS at v2. This migration applies the missing seed flip.
--
-- Invariants preserved (mirrors scripts/011)
--   - `idx_algorithm_versions_one_current` is a partial unique index on
--     `algorithm_versions(kind) WHERE current_effective`. We flip v1 to
--     false BEFORE upserting v2 with true, inside a single transaction,
--     so the constraint never sees two effective rows for the kind.
--   - Idempotent (re-run-safe) via the targeted UPDATE plus the upsert's
--     ON CONFLICT clause.
--   - No existing v1-stamped derivation rows are touched. Historical
--     `clusters.label_algorithm_version = 'v1'` rows stay readable; the
--     021 backfill script handles the catch-up writes.

begin;

update algorithm_versions
   set current_effective = false
 where kind = 'semantic_cluster_label'
   and version = 'v1';

insert into algorithm_versions (kind, version, current_effective, notes) values
  (
    'semantic_cluster_label',
    'v2',
    true,
    'Topic+error prompt context, small/large LLM escalation, deterministic Topic+error fallback so every cluster has a displayable label (see lib/storage/cluster-label-fallback.ts and docs/CLUSTERING_DESIGN.md §4.4)'
  )
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
