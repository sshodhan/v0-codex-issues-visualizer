-- 030_preflight_probes.sql
--
-- Read-only probes to run before applying
-- scripts/030_family_classification_reviews.sql.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/030_preflight_probes.sql
--
-- Each probe prints a labelled result row. Nothing writes; safe to run
-- against production at any time.

\echo '=== 1. FK targets present (029 family_classifications, 007 clusters) ==='
select
  to_regclass('public.family_classifications') as fk_target_029,
  to_regclass('public.clusters')               as fk_target_007;
-- expected: both non-null. If either is null, stop — apply the missing
-- migration first.

\echo ''
\echo '=== 2. 030 objects not already present ==='
select
  to_regclass('public.family_classification_reviews')        as table_present,
  to_regclass('public.family_classification_review_current') as view_present;
-- expected: both null. Non-null means a prior partial apply; 030 is
-- idempotent (create … if not exists / create or replace view) but you
-- want to know before assuming a clean run.

\echo ''
\echo '=== 3. gen_random_uuid() callable (030 id default) ==='
select gen_random_uuid() as sample_uuid;

\echo ''
\echo '=== 4. RLS roles exist (030 grants policies to anon, authenticated, service_role) ==='
select rolname
from pg_roles
where rolname in ('anon', 'authenticated', 'service_role')
order by rolname;
-- expected: 3 rows.

\echo ''
\echo '=== 5. There are family_classifications rows for reviews to attach to ==='
select
  count(*)                                                          as classifications_total,
  count(*) filter (where computed_at > now() - interval '7 days')   as classifications_recent_7d
from family_classifications;

\echo ''
\echo '=== 6. No name collisions with the 8 indexes 030 will create ==='
select indexname
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'idx_family_classification_reviews_classification_reviewed',
    'idx_family_classification_reviews_cluster',
    'idx_family_classification_reviews_verdict',
    'idx_family_classification_reviews_decision',
    'idx_family_classification_reviews_quality_bucket',
    'idx_family_classification_reviews_error_source',
    'idx_family_classification_reviews_error_reason',
    'idx_family_classification_reviews_reviewed_at'
  )
order by indexname;
-- expected: 0 rows.

\echo ''
\echo '=== 7. RLS policy names 030 drops/creates not held by an unrelated table ==='
select schemaname, tablename, policyname
from pg_policies
where policyname in (
  'public_read_family_classification_reviews',
  'service_rw_family_classification_reviews'
);
-- expected: 0 rows (or, if 030 partially applied, 2 rows on
-- family_classification_reviews — the migration drops + recreates them).
