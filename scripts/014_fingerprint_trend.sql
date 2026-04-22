-- ============================================================================
-- Migration 014: Fingerprint time-series MV + surge detection
--
-- Adds a read-optimized time-series surface for regex-extracted error codes so
-- the dashboard can answer "is something breaking right now?" without scanning
-- `bug_fingerprints` on every request.
--
-- Invariants preserved:
--   * No write path changes. `bug_fingerprints` stays append-only (013).
--   * No `algorithm_version` bump — no derivation shape changed.
--   * `mv_observation_current` is NOT dropped. 014 adds an independent MV and
--     a per-cluster source-diversity view that depend on existing columns.
--   * `refresh_materialized_views()` is redefined in place to fold in the new
--     MV; the existing MVs refresh exactly as before.
--
-- Safe to re-run: MV / view / function creation is idempotent.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) Daily time-series aggregate of regex-extracted error codes.
-- ----------------------------------------------------------------------------
-- One row per (day, error_code) over the last 60 days. `source_diversity`
-- is the distinct source count on that day, so cross-source amplification
-- is visible without another join at read time.

create materialized view if not exists mv_fingerprint_daily as
select
  date_trunc('day', o.published_at) as day,
  bf.error_code,
  count(*)::bigint as cnt,
  count(distinct s.slug)::int as source_diversity
from bug_fingerprints bf
join observations o on o.id = bf.observation_id
join sources s on s.id = o.source_id
where bf.error_code is not null
  and o.published_at is not null
  and o.published_at >= now() - interval '60 days'
group by 1, 2;

create index if not exists idx_mv_fingerprint_daily_code_day
  on mv_fingerprint_daily (error_code, day desc);
create index if not exists idx_mv_fingerprint_daily_day
  on mv_fingerprint_daily (day desc);

-- ----------------------------------------------------------------------------
-- 2) Per-cluster source diversity view.
-- ----------------------------------------------------------------------------
-- Feeds the 7% source-diversity term in the actionability score. Reads from
-- mv_observation_current (which carries cluster_id for every observation, not
-- just canonicals) so `count(distinct source_id)` is the cross-source
-- confirmation signal at cluster granularity.

create or replace view v_cluster_source_diversity as
select
  cluster_id,
  count(distinct source_id)::int as source_diversity
from mv_observation_current
where cluster_id is not null
group by cluster_id;

grant select on v_cluster_source_diversity to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3) Read-time surge detection.
-- ----------------------------------------------------------------------------
-- Compares the current window to the preceding equal-length window at day
-- granularity. Using day buckets (not rolling seconds) keeps the function
-- reading straight off the MV indexes; the cost of the approximation is a
-- single partial-day overlap, which the dashboard card explicitly frames as
-- "in the last <N> h" rather than a sliding window.
--
-- `prev_count = 0` + `now_count > 0` is the "new in window" signal consumed
-- by the client (see lib/analytics/fingerprint-surge.ts).

create or replace function fingerprint_surges(window_hours int default 24)
returns table(error_code text, now_count bigint, prev_count bigint, delta bigint, sources int)
language sql
stable
as $$
  with bounds as (
    select
      now() - make_interval(hours => greatest(coalesce(window_hours, 24), 1)) as now_start,
      now() - make_interval(hours => greatest(coalesce(window_hours, 24), 1) * 2) as prev_start
  ),
  agg as (
    select
      m.error_code,
      sum(case when m.day >= date_trunc('day', b.now_start) then m.cnt else 0 end)::bigint as now_count,
      sum(case
        when m.day >= date_trunc('day', b.prev_start)
         and m.day <  date_trunc('day', b.now_start)
        then m.cnt else 0
      end)::bigint as prev_count,
      max(m.source_diversity)::int as sources
    from mv_fingerprint_daily m
    cross join bounds b
    group by m.error_code
  )
  select
    error_code,
    now_count,
    prev_count,
    (now_count - prev_count) as delta,
    sources
  from agg
  where now_count > 0
  order by delta desc, now_count desc, error_code asc
$$;

grant execute on function fingerprint_surges(int) to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4) Extend refresh_materialized_views() to refresh the new MV.
-- ----------------------------------------------------------------------------
-- Concurrency contract is preserved: mv_observation_current uses CONCURRENTLY
-- (it has a unique index); mv_trend_daily and mv_fingerprint_daily don't, so
-- they take the plain (locking) refresh as before for mv_trend_daily.

create or replace function refresh_materialized_views()
returns void
language plpgsql
security definer
as $$
begin
  refresh materialized view concurrently mv_observation_current;
  refresh materialized view mv_trend_daily;
  refresh materialized view mv_fingerprint_daily;
end;
$$;

grant execute on function refresh_materialized_views() to service_role;

commit;
