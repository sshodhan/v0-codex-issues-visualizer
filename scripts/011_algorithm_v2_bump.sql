-- 011_algorithm_v2_bump.sql
--
-- Registers v2 of the impact / sentiment / category derivation algorithms in
-- the `algorithm_versions` registry and flips v1 off as current_effective.
--
-- Why v2 exists:
--   - impact v2 adds source-authority weighting (first-party GitHub issues
--     outrank announcement/news channels at identical engagement).
--   - sentiment v2 expands the negative-polarity lexicon with complaint
--     markers that v1 missed ("unable", "stuck", "broken", "missing", …)
--     plus multi-word patterns ("does not work", "keeps <V-ing>").
--   - category v2 expands phrase lists and lowers the Other-fallback
--     threshold from 2 to 1 so any single phrase hit wins over Other.
--
-- Invariants preserved:
--   - Derivation tables (sentiment_scores, category_assignments,
--     impact_scores) are NOT updated. The next enrich pass writes fresh v2
--     rows alongside the existing v1 rows for replay comparison
--     (docs/ARCHITECTURE.md v10 §7.4).
--   - `idx_algorithm_versions_one_current` is a partial unique index on
--     `algorithm_versions(kind) WHERE current_effective`. We flip v1 to
--     false BEFORE inserting v2 with true, inside a single transaction,
--     so the constraint never sees two effective rows per kind.
--   - Idempotent (re-run-safe) via the UPDATE and the upsert's
--     ON CONFLICT clause.

begin;

update algorithm_versions
   set current_effective = false
 where kind in ('impact', 'sentiment', 'category')
   and version = 'v1';

insert into algorithm_versions (kind, version, current_effective, notes) values
  ('impact',    'v2', true, 'Source-authority weighting (eye-test Pattern A)'),
  ('sentiment', 'v2', true, 'Complaint-marker lexicon + multi-word patterns (eye-test Pattern B)'),
  ('category',  'v2', true, 'Broader phrase lists + threshold=1 for non-Other (eye-test Pattern C)')
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
