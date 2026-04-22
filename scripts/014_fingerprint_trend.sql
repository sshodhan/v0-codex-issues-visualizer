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

-- A UNIQUE index is a prerequisite for `REFRESH MATERIALIZED VIEW
-- CONCURRENTLY`. The MV's GROUP BY guarantees one row per (day, error_code)
-- pair, so the unique constraint is free correctness-wise and leaves the
-- door open for a follow-up patch to switch the refresh to non-blocking.
create unique index if not exists idx_mv_fingerprint_daily_day_code
  on mv_fingerprint_daily (day, error_code);
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
-- Compares the current window to the preceding equal-length window. The MV
-- is bucketed by day, so windows snap to day granularity: `window_hours` is
-- rounded up to calendar days (`ceil(hours/24)`), and both `now_count` and
-- `prev_count` are sums of exactly that many full day-buckets. The result:
-- a `window_hours=24` call compares today vs yesterday (each 1 day); a
-- `window_hours=48` call compares the last 2 days vs the prior 2 days; and
-- so on.
--
-- Using full-day buckets (not a rolling seconds window) keeps the function
-- reading straight off the MV index. The payload carries `window_days` so
-- the dashboard card can render honest copy ("today vs yesterday") rather
-- than an approximate "last 24 h" that drifts with the clock.
--
-- `prev_count = 0` + `now_count > 0` is the "new in window" signal consumed
-- by the client (see lib/analytics/fingerprint-surge.ts).

create or replace function fingerprint_surges(window_hours int default 24)
returns table(
  error_code text,
  now_count bigint,
  prev_count bigint,
  delta bigint,
  sources int,
  window_days int
)
language sql
stable
as $$
  with bounds as (
    select
      -- ceil(hours/24), floored at 1 — we always compare at least one full
      -- day on each side.
      greatest(ceil(coalesce(window_hours, 24)::numeric / 24)::int, 1) as window_days
  ),
  horizons as (
    select
      b.window_days,
      -- Anchor both windows to the start of today (UTC). `now_start` is
      -- today minus (N-1) days → covers N full days ending today.
      -- `prev_start` is `now_start` minus N days → covers the prior N.
      date_trunc('day', now()) - make_interval(days => b.window_days - 1) as now_start,
      date_trunc('day', now()) - make_interval(days => b.window_days * 2 - 1) as prev_start
    from bounds b
  ),
  agg as (
    select
      m.error_code,
      sum(case when m.day >= h.now_start then m.cnt else 0 end)::bigint as now_count,
      sum(case
        when m.day >= h.prev_start and m.day < h.now_start
        then m.cnt else 0
      end)::bigint as prev_count,
      max(m.source_diversity)::int as sources,
      h.window_days
    from mv_fingerprint_daily m
    cross join horizons h
    group by m.error_code, h.window_days
  )
  select
    error_code,
    now_count,
    prev_count,
    (now_count - prev_count) as delta,
    sources,
    window_days
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
