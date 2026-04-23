-- ============================================================================
-- Migration 015: Schema verifier RPC
--
-- Adds `get_schema_snapshot()` — a single SECURITY DEFINER function that
-- returns the current `public` schema as a JSONB blob (tables, views,
-- materialized views, indexes, functions, per-table columns, plus the
-- algorithm-version registry rows).
--
-- The admin tab `/admin` (Schema verification) compares this snapshot
-- against the expected manifest in `lib/schema/expected-manifest.ts` and
-- reports per-object pass/fail. Diff lives in TypeScript so updating the
-- manifest after a future migration is a code change, not a SQL change.
--
-- Why a single RPC, not many `to_regclass` round-trips:
--   * One round trip beats ~80 (one per object). The verifier UI is
--     interactive — latency matters.
--   * Reading pg_catalog / information_schema requires a server-side
--     function under the service-role client. A single snapshot also
--     keeps the surface tight: anything outside this function cannot
--     read system catalogs through the admin client.
--
-- Safe to re-run: function definition is idempotent.
-- Read-only: function does not mutate any table; SECURITY DEFINER only
-- broadens read of system catalogs, which are already visible to the
-- service role. Marked STABLE so the planner can cache within a query.
-- ============================================================================

begin;

create or replace function get_schema_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- Base tables in public.
  tabs as (
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  ),
  -- Plain views (NOT materialized — those live in pg_matviews).
  vws as (
    select table_name as view_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'VIEW'
  ),
  -- Materialized views.
  mvs as (
    select matviewname as mv_name from pg_matviews where schemaname = 'public'
  ),
  -- Indexes on public-schema relations.
  idxs as (
    select indexname from pg_indexes where schemaname = 'public'
  ),
  -- Routines in public. `routine_name` is enough — argument-overload
  -- distinction isn't needed for the existence check the manifest does.
  fns as (
    select distinct routine_name
    from information_schema.routines
    where routine_schema = 'public' and routine_type = 'FUNCTION'
  ),
  -- Per-table columns. Manifest uses this for "row exists, but column X
  -- is missing" checks (e.g. clusters.label after migration 012).
  cols as (
    select table_name, jsonb_agg(column_name order by ordinal_position) as col_list
    from information_schema.columns
    where table_schema = 'public'
    group by table_name
  ),
  -- Algorithm-version registry rows. 011 doesn't change schema — it
  -- inserts v2 rows into `algorithm_versions`. Capture the currently
  -- effective row per kind so the manifest can verify v2 (or later) is
  -- actually flipped on.
  alg as (
    select kind, version
    from algorithm_versions
    where current_effective = true
  )
  select jsonb_build_object(
    'tables',     coalesce((select jsonb_agg(table_name order by table_name) from tabs), '[]'::jsonb),
    'views',      coalesce((select jsonb_agg(view_name  order by view_name)  from vws),  '[]'::jsonb),
    'matviews',   coalesce((select jsonb_agg(mv_name    order by mv_name)    from mvs),  '[]'::jsonb),
    'indexes',    coalesce((select jsonb_agg(indexname  order by indexname)  from idxs), '[]'::jsonb),
    'functions',  coalesce((select jsonb_agg(routine_name order by routine_name) from fns), '[]'::jsonb),
    'columns',    coalesce((select jsonb_object_agg(table_name, col_list) from cols), '{}'::jsonb),
    'algorithm_versions_current',
                  coalesce((select jsonb_object_agg(kind, version) from alg), '{}'::jsonb),
    'snapshot_at', to_jsonb(now())
  );
$$;

grant execute on function get_schema_snapshot() to service_role;

commit;
