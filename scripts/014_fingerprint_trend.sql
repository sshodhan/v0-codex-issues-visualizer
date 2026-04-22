begin;

create materialized view if not exists mv_fingerprint_daily as
select
  date_trunc('day', o.published_at) as day,
  bf.error_code,
  count(*) as cnt,
  count(distinct s.slug) as source_diversity
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

create or replace function fingerprint_surges(window_hours int default 24)
returns table(error_code text, now_count bigint, prev_count bigint, delta bigint, sources int)
language sql
stable
as $$
  with bounds as (
    select
      now() - make_interval(hours => greatest(window_hours, 1)) as now_start,
      now() - make_interval(hours => greatest(window_hours, 1) * 2) as prev_start
  ),
  agg as (
    select
      m.error_code,
      sum(case when m.day >= date_trunc('day', b.now_start) then m.cnt else 0 end)::bigint as now_count,
      sum(
        case
          when m.day >= date_trunc('day', b.prev_start)
           and m.day < date_trunc('day', b.now_start)
          then m.cnt
          else 0
        end
      )::bigint as prev_count,
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
grant execute on function fingerprint_surges(int) to anon, authenticated, service_role;

commit;
