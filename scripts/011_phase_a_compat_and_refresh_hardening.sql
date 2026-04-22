-- ============================================================================
-- Migration 011: Phase-A compatibility layer + MV refresh hardening
--
-- Rebased on current main (post 007/008/009/010):
--   * 007 replaced the monolithic `issues` table and `upsert_issue_observation`
--     RPC with the three-layer model. Legacy callers still referencing those
--     names break until the compat view/RPC below are in place.
--   * 007 left `refresh_materialized_views()` as a plain void-returning RPC
--     with no per-MV timing, no partial-failure reporting, and no budget.
--   * 007's MV set is `mv_observation_current` and `mv_trend_daily`
--     (`mv_dashboard_stats` was removed in the DB-analyst review — see
--     docs/BUGS.md P1-ish item "drop dead MV"). Do NOT reference it here.
--   * 010_perf_indexes.sql added partial + trigram indexes on
--     `mv_observation_current`; this file does not touch those.
--
-- Purpose:
-- 1) Reintroduce compatibility read/write surfaces so rollouts can keep
--    legacy callers alive while the three-layer APIs are verified.
-- 2) Harden refresh_materialized_views with per-MV timing, partial-failure
--    reporting, and budget-aware degraded mode.
--
-- REFRESH MATERIALIZED VIEW CONCURRENTLY note: the restriction is against
-- running inside an explicit multi-statement transaction, not against plpgsql
-- function bodies. 007's existing refresh function already calls
-- `refresh materialized view concurrently mv_observation_current` from inside
-- a security-definer plpgsql function, so this file keeps CONCURRENTLY for
-- every MV that has a unique index (all of them, after the index added below
-- for mv_trend_daily).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Legacy compatibility view: issues
--
-- Shapes `mv_observation_current` back into the column set the pre-007 `issues`
-- table exposed, so dashboards / adhoc SQL / downstream consumers that still
-- reference `public.issues` keep working through the phased cutover. Phase B
-- (012_phase_b_cleanup.sql) drops this view after verification.
-- ---------------------------------------------------------------------------
create or replace view issues as
select
  observation_id as id,
  source_id,
  category_id,
  external_id,
  title,
  content,
  url,
  author,
  sentiment,
  sentiment_score,
  impact_score,
  coalesce(frequency_count, 1)::int as frequency_count,
  coalesce(upvotes, 0)::int as upvotes,
  coalesce(comments_count, 0)::int as comments_count,
  published_at,
  captured_at as scraped_at,
  captured_at as last_seen_at,
  captured_at as created_at,
  captured_at as updated_at
from mv_observation_current;

grant select on issues to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Legacy compatibility RPC: upsert_issue_observation(jsonb)
--
-- Routes the old single-call contract through the typed three-layer RPCs so
-- any legacy caller still invoking `rpc("upsert_issue_observation", payload)`
-- produces the same end state as the new `record_observation` +
-- `record_sentiment` / `record_category` / `record_impact` pipeline.
-- ---------------------------------------------------------------------------
create or replace function upsert_issue_observation(payload jsonb)
returns uuid
language plpgsql
security definer
as $$
declare
  obs_id uuid;
  sent_label text;
begin
  obs_id := record_observation(jsonb_build_object(
    'source_id', payload->>'source_id',
    'external_id', payload->>'external_id',
    'title', payload->>'title',
    'content', payload->>'content',
    'url', payload->>'url',
    'author', payload->>'author',
    'published_at', payload->>'published_at'
  ));

  if obs_id is null then
    return null;
  end if;

  perform record_engagement_snapshot(
    obs_id,
    coalesce((payload->>'upvotes')::int, 0),
    coalesce((payload->>'comments_count')::int, 0)
  );

  sent_label := payload->>'sentiment';
  if sent_label in ('positive', 'negative', 'neutral') then
    perform record_sentiment(
      obs_id,
      'compat-v1',
      coalesce((payload->>'sentiment_score')::numeric, 0),
      sent_label,
      0
    );
  end if;

  if nullif(payload->>'category_id', '') is not null then
    perform record_category(
      obs_id,
      'compat-v1',
      (payload->>'category_id')::uuid,
      1.0
    );
  end if;

  if nullif(payload->>'impact_score', '') is not null then
    perform record_impact(
      obs_id,
      'compat-v1',
      greatest(1, least(10, (payload->>'impact_score')::int)),
      jsonb_build_object(
        'upvotes', coalesce((payload->>'upvotes')::int, 0),
        'comments_count', coalesce((payload->>'comments_count')::int, 0),
        'sentiment_label', coalesce(payload->>'sentiment', 'neutral')
      )
    );
  end if;

  perform attach_to_cluster(obs_id, 'compat:' || md5(coalesce(payload->>'title', '')));

  return obs_id;
end;
$$;

grant execute on function upsert_issue_observation(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Refresh hardening: metrics + degraded mode
--
-- mv_observation_current already has a unique PK index from 007.
-- mv_trend_daily needs one so we can REFRESH ... CONCURRENTLY below. The
-- MV's GROUP BY guarantees uniqueness on (day, sentiment).
-- ---------------------------------------------------------------------------
create unique index if not exists idx_mv_trend_daily_unique
  on mv_trend_daily (day, sentiment);

-- The zero-arg refresh function existed in 007 with `returns void`; we need
-- to drop it before the jsonb-returning replacement below, because
-- `create or replace function` cannot change a function's return type.
drop function if exists refresh_materialized_views();

create or replace function refresh_materialized_views(max_budget_ms int default 15000)
returns jsonb
language plpgsql
security definer
as $$
declare
  started_at timestamptz := clock_timestamp();
  mv_started timestamptz;
  elapsed_ms int;
  budget_used int;
  results jsonb := '[]'::jsonb;
  failure_count int := 0;
begin
  -- mv_observation_current
  if max_budget_ms > 0 and (extract(epoch from (clock_timestamp() - started_at)) * 1000)::int > max_budget_ms then
    results := results || jsonb_build_array(jsonb_build_object('name', 'mv_observation_current', 'status', 'skipped_budget'));
  else
    mv_started := clock_timestamp();
    begin
      refresh materialized view concurrently mv_observation_current;
      elapsed_ms := (extract(epoch from (clock_timestamp() - mv_started)) * 1000)::int;
      results := results || jsonb_build_array(jsonb_build_object('name', 'mv_observation_current', 'status', 'ok', 'duration_ms', elapsed_ms));
      raise log '[refresh_materialized_views] % refreshed in % ms', 'mv_observation_current', elapsed_ms;
    exception when others then
      failure_count := failure_count + 1;
      results := results || jsonb_build_array(jsonb_build_object('name', 'mv_observation_current', 'status', 'error', 'error', sqlerrm));
      raise warning '[refresh_materialized_views] % failed: %', 'mv_observation_current', sqlerrm;
    end;
  end if;

  -- mv_trend_daily (depends on mv_observation_current; keep same order as 007)
  if max_budget_ms > 0 and (extract(epoch from (clock_timestamp() - started_at)) * 1000)::int > max_budget_ms then
    results := results || jsonb_build_array(jsonb_build_object('name', 'mv_trend_daily', 'status', 'skipped_budget'));
  else
    mv_started := clock_timestamp();
    begin
      refresh materialized view concurrently mv_trend_daily;
      elapsed_ms := (extract(epoch from (clock_timestamp() - mv_started)) * 1000)::int;
      results := results || jsonb_build_array(jsonb_build_object('name', 'mv_trend_daily', 'status', 'ok', 'duration_ms', elapsed_ms));
      raise log '[refresh_materialized_views] % refreshed in % ms', 'mv_trend_daily', elapsed_ms;
    exception when others then
      failure_count := failure_count + 1;
      results := results || jsonb_build_array(jsonb_build_object('name', 'mv_trend_daily', 'status', 'error', 'error', sqlerrm));
      raise warning '[refresh_materialized_views] % failed: %', 'mv_trend_daily', sqlerrm;
    end;
  end if;

  budget_used := (extract(epoch from (clock_timestamp() - started_at)) * 1000)::int;

  return jsonb_build_object(
    'started_at', started_at,
    'duration_ms', budget_used,
    'budget_ms', max_budget_ms,
    'failed', failure_count,
    'degraded', exists (
      select 1
      from jsonb_array_elements(results) as e
      where (e->>'status') in ('skipped_budget', 'error')
    ),
    'views', results
  );
end;
$$;

grant execute on function refresh_materialized_views(int) to service_role;

create or replace function refresh_materialized_views()
returns jsonb
language sql
security definer
as $$
  select refresh_materialized_views(15000);
$$;

grant execute on function refresh_materialized_views() to service_role;

commit;
