-- ============================================================================
-- Migration 010: Phase-A compatibility layer + MV refresh hardening
--
-- Purpose:
-- 1) Reintroduce compatibility read/write surfaces so rollouts can keep
--    legacy callers alive while the three-layer APIs are verified.
-- 2) Harden refresh_materialized_views with per-MV timing, partial-failure
--    reporting, and budget-aware degraded mode.
--
-- NOTE: REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a function
-- transaction block. This function therefore uses non-concurrent refreshes
-- and returns diagnostics; ops can run concurrent refreshes manually when
-- needed from direct SQL sessions outside function context.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Legacy compatibility view: issues
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
-- ---------------------------------------------------------------------------
create unique index if not exists idx_mv_trend_daily_unique on mv_trend_daily (day, sentiment);
create unique index if not exists idx_mv_dashboard_stats_singleton on mv_dashboard_stats ((1));

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
      refresh materialized view mv_observation_current;
      elapsed_ms := (extract(epoch from (clock_timestamp() - mv_started)) * 1000)::int;
      results := results || jsonb_build_array(jsonb_build_object('name', 'mv_observation_current', 'status', 'ok', 'duration_ms', elapsed_ms));
      raise log '[refresh_materialized_views] % refreshed in % ms', 'mv_observation_current', elapsed_ms;
    exception when others then
      failure_count := failure_count + 1;
      results := results || jsonb_build_array(jsonb_build_object('name', 'mv_observation_current', 'status', 'error', 'error', sqlerrm));
      raise warning '[refresh_materialized_views] % failed: %', 'mv_observation_current', sqlerrm;
    end;
  end if;

  -- mv_dashboard_stats
  if max_budget_ms > 0 and (extract(epoch from (clock_timestamp() - started_at)) * 1000)::int > max_budget_ms then
    results := results || jsonb_build_array(jsonb_build_object('name', 'mv_dashboard_stats', 'status', 'skipped_budget'));
  else
    mv_started := clock_timestamp();
    begin
      refresh materialized view mv_dashboard_stats;
      elapsed_ms := (extract(epoch from (clock_timestamp() - mv_started)) * 1000)::int;
      results := results || jsonb_build_array(jsonb_build_object('name', 'mv_dashboard_stats', 'status', 'ok', 'duration_ms', elapsed_ms));
      raise log '[refresh_materialized_views] % refreshed in % ms', 'mv_dashboard_stats', elapsed_ms;
    exception when others then
      failure_count := failure_count + 1;
      results := results || jsonb_build_array(jsonb_build_object('name', 'mv_dashboard_stats', 'status', 'error', 'error', sqlerrm));
      raise warning '[refresh_materialized_views] % failed: %', 'mv_dashboard_stats', sqlerrm;
    end;
  end if;

  -- mv_trend_daily
  if max_budget_ms > 0 and (extract(epoch from (clock_timestamp() - started_at)) * 1000)::int > max_budget_ms then
    results := results || jsonb_build_array(jsonb_build_object('name', 'mv_trend_daily', 'status', 'skipped_budget'));
  else
    mv_started := clock_timestamp();
    begin
      refresh materialized view mv_trend_daily;
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
