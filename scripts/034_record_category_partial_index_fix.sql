-- 034_record_category_partial_index_fix.sql
--
-- Bug fix: record_category() RPC's ON CONFLICT clause references a unique
-- constraint that no longer exists, causing every insert to fail with
-- 42P10 "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification".
--
-- Root cause: scripts/031_topic_review_events.sql dropped the unique
-- constraint `category_assignments_observation_id_algorithm_version_key`
-- (originally created in 007) and replaced it with a PARTIAL unique
-- index `category_assignments_obs_alg_nonmanual_uniq` that excludes
-- algorithm_version = 'manual'. PostgreSQL ON CONFLICT requires the
-- conflict target to match a non-partial unique constraint OR include
-- the same WHERE predicate when matching a partial unique index.
--
-- The record_category() RPC defined in 026 used the bare form
--   ON CONFLICT (observation_id, algorithm_version) DO NOTHING
-- which matched the original constraint but no longer matches the
-- partial index. Any caller of record_category() after 031 was applied
-- would have failed; the bug surfaced when re-running the Layer 0
-- Backfill admin tool against live data.
--
-- Fix: rewrite record_category() with the WHERE predicate included in
-- the conflict target so PostgreSQL matches the partial unique index.
-- Behavior is unchanged for callers — algorithm_version is never
-- 'manual' for any deterministic write path (manual overrides go
-- through a separate RPC defined in 031).
--
-- Idempotent: drop+recreate of the function. No data migration.

begin;

drop function if exists record_category(uuid, text, uuid, numeric, jsonb) cascade;

create or replace function record_category(
  obs_id uuid,
  ver    text,
  cat_id uuid,
  conf   numeric,
  ev     jsonb
)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into category_assignments (
    observation_id, algorithm_version, category_id, confidence, evidence
  )
  values (obs_id, ver, cat_id, conf, ev)
  on conflict (observation_id, algorithm_version)
    where algorithm_version <> 'manual'
    do nothing
  returning id into row_id;
  return row_id;
end;
$$;

grant execute on function record_category(uuid, text, uuid, numeric, jsonb) to service_role;

commit;
