-- 031_preflight_probes.sql
--
-- Read-only probes to run before applying
-- scripts/031_topic_review_events.sql.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/031_preflight_probes.sql
--
-- Each probe prints a labelled result row. Nothing writes; safe to run
-- against production at any time.
--
-- 031 is materially riskier than 030 because it swaps a UNIQUE
-- CONSTRAINT on a populated table (`category_assignments`) for a
-- partial unique index. Probe 5 is the one that matters most: if there
-- are duplicate non-manual (observation_id, algorithm_version) rows,
-- the new partial unique index will fail to build and the migration
-- will roll back.

\echo '=== 1. FK targets present (observations, categories) ==='
select
  to_regclass('public.observations') as fk_target_observations,
  to_regclass('public.categories')   as fk_target_categories;
-- expected: both non-null.

\echo ''
\echo '=== 2. 031 objects not already present (table + 2 RPCs) ==='
select to_regclass('public.topic_review_events') as table_present;

select proname
from pg_proc
where proname in ('record_topic_review_event', 'record_manual_topic_override')
order by proname;
-- expected: table null, 0 rows from pg_proc.

\echo ''
\echo '=== 3. The constraint 031 drops is the one currently in place ==='
select conname
from pg_constraint
where conrelid = 'public.category_assignments'::regclass
  and conname = 'category_assignments_observation_id_algorithm_version_key';
-- expected: 1 row. If 0, the original UNIQUE was already dropped by a
-- prior partial apply or a hand-fix; ALTER TABLE … DROP CONSTRAINT IF
-- EXISTS will be a no-op which is fine, but you want to know.

\echo ''
\echo '=== 4. No name collisions for the 8 indexes 031 creates ==='
select indexname
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'category_assignments_obs_alg_nonmanual_uniq',
    'idx_category_assignments_manual_obs',
    'idx_topic_review_events_observation_id',
    'idx_topic_review_events_reason_code',
    'idx_topic_review_events_suggested_layer',
    'idx_topic_review_events_suggested_action',
    'idx_topic_review_events_status',
    'idx_topic_review_events_created_at'
  )
order by indexname;
-- expected: 0 rows.

\echo ''
\echo '=== 5. CRITICAL: no duplicate non-manual (observation_id, algorithm_version) pairs ==='
-- The new partial unique index is
--   on (observation_id, algorithm_version) where algorithm_version <> 'manual'
-- Any duplicate non-manual pair will fail the CREATE UNIQUE INDEX and
-- roll the whole migration back.
select count(*) as duplicate_groups
from (
  select observation_id, algorithm_version
  from category_assignments
  where algorithm_version <> 'manual'
  group by observation_id, algorithm_version
  having count(*) > 1
) dup;
-- expected: 0. If non-zero, list them:

select observation_id, algorithm_version, count(*) as dup_count
from category_assignments
where algorithm_version <> 'manual'
group by observation_id, algorithm_version
having count(*) > 1
order by dup_count desc
limit 10;
-- expected: 0 rows.

\echo ''
\echo '=== 6. Existing manual overrides (informational — they will all be retained) ==='
select count(*) as existing_manual_overrides
from category_assignments
where algorithm_version = 'manual';
-- any number is fine; the new partial-unique index excludes manual rows.

\echo ''
\echo '=== 7. service_role exists (031 grants execute on both RPCs to it) ==='
select rolname from pg_roles where rolname = 'service_role';
-- expected: 1 row.

\echo ''
\echo '=== 8. RLS policy names 031 creates not held by an unrelated table ==='
select schemaname, tablename, policyname
from pg_policies
where policyname in (
  'service_all_topic_review_events',
  'public_read_topic_review_events'
);
-- expected: 0 rows (or, on a partial re-apply, 2 rows on
-- topic_review_events — 031 drops + recreates them).
