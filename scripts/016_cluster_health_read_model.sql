-- ============================================================================
-- Migration 016: read-side cluster health model for UI trust affordances
--
-- Adds `mv_cluster_health_current`, a materialized read model keyed by
-- `cluster_id`, computed from current cluster membership (via
-- mv_observation_current canonical rows), fingerprint consistency, and
-- classification/review coverage.
--
-- Intended consumers:
--   * /api/clusters
--   * /api/clusters/rollup
--   * trust-ribbon UI affordances in triage + story surfaces
-- ============================================================================

begin;

drop materialized view if exists mv_cluster_health_current;

create materialized view mv_cluster_health_current as
with canonical as (
  select
    m.cluster_id,
    m.cluster_key,
    m.observation_id,
    m.error_code,
    m.top_stack_frame_hash,
    m.llm_classified_at
  from mv_observation_current m
  where m.is_canonical
    and m.cluster_id is not null
),
latest_review as (
  select distinct on (classification_id)
    classification_id,
    reviewed_at
  from classification_reviews
  order by classification_id, reviewed_at desc
),
class_state as (
  select
    c.observation_id,
    c.id as classification_id,
    lr.reviewed_at
  from (
    select distinct on (observation_id)
      id,
      observation_id,
      created_at
    from classifications
    where observation_id is not null
    order by observation_id, created_at desc
  ) c
  left join latest_review lr on lr.classification_id = c.id
),
base as (
  select
    c.cluster_id,
    min(c.cluster_key) as cluster_key,
    count(*)::int as cluster_size,
    count(*) filter (where c.llm_classified_at is not null)::int as classified_count,
    count(*) filter (where cs.reviewed_at is not null)::int as reviewed_count,
    count(*) filter (
      where c.error_code is not null or c.top_stack_frame_hash is not null
    )::int as fingerprint_hit_count
  from canonical c
  left join class_state cs on cs.observation_id = c.observation_id
  group by c.cluster_id
),
error_counts as (
  select
    c.cluster_id,
    c.error_code,
    count(*)::int as cnt
  from canonical c
  where c.error_code is not null
  group by c.cluster_id, c.error_code
),
error_ranked as (
  select
    cluster_id,
    cnt,
    row_number() over (partition by cluster_id order by cnt desc, cluster_id) as rn
  from error_counts
),
frame_counts as (
  select
    c.cluster_id,
    c.top_stack_frame_hash,
    count(*)::int as cnt
  from canonical c
  where c.top_stack_frame_hash is not null
  group by c.cluster_id, c.top_stack_frame_hash
),
frame_ranked as (
  select
    cluster_id,
    cnt,
    row_number() over (partition by cluster_id order by cnt desc, cluster_id) as rn
  from frame_counts
),
error_top as (
  select
    cluster_id,
    max(case when rn = 1 then cnt end)::int as top_cnt,
    max(case when rn = 2 then cnt end)::int as second_cnt
  from error_ranked
  group by cluster_id
),
frame_top as (
  select
    cluster_id,
    max(case when rn = 1 then cnt end)::int as top_cnt
  from frame_ranked
  group by cluster_id
)
select
  b.cluster_id,
  case
    when b.cluster_key like 'semantic:%' then 'semantic'
    else 'fallback'
  end::text as cluster_path,
  b.cluster_size,
  b.classified_count,
  b.reviewed_count,
  b.fingerprint_hit_count,
  case
    when b.cluster_size > 0 then b.fingerprint_hit_count::numeric / b.cluster_size::numeric
    else 0::numeric
  end::numeric(5,4) as fingerprint_hit_rate,
  case
    when b.cluster_size > 0 then coalesce(et.top_cnt, 0)::numeric / b.cluster_size::numeric
    else 0::numeric
  end::numeric(5,4) as dominant_error_code_share,
  case
    when b.cluster_size > 0 then coalesce(ft.top_cnt, 0)::numeric / b.cluster_size::numeric
    else 0::numeric
  end::numeric(5,4) as dominant_stack_frame_share,
  case
    when b.cluster_size > 0 then greatest(coalesce(et.top_cnt, 0), coalesce(ft.top_cnt, 0))::numeric / b.cluster_size::numeric
    else 0::numeric
  end::numeric(5,4) as intra_cluster_similarity_proxy,
  case
    when b.cluster_size > 0 then
      greatest(coalesce(et.top_cnt, 0), coalesce(ft.top_cnt, 0))::numeric / b.cluster_size::numeric
      -
      (coalesce(et.second_cnt, 0)::numeric / b.cluster_size::numeric)
    else 0::numeric
  end::numeric(5,4) as nearest_cluster_gap_proxy
from base b
left join error_top et on et.cluster_id = b.cluster_id
left join frame_top ft on ft.cluster_id = b.cluster_id;

create unique index if not exists idx_mv_cluster_health_current_cluster
  on mv_cluster_health_current (cluster_id);

create index if not exists idx_mv_cluster_health_current_size
  on mv_cluster_health_current (cluster_size desc);

create or replace function refresh_materialized_views()
returns void
language plpgsql
security definer
as $$
begin
  refresh materialized view concurrently mv_observation_current;
  refresh materialized view mv_trend_daily;
  refresh materialized view mv_fingerprint_daily;
  refresh materialized view mv_cluster_health_current;
end;
$$;

grant execute on function refresh_materialized_views() to service_role;

commit;
