-- ============================================================================
-- Migration 018: expose `source_name` on mv_observation_current
--
-- PostgREST cannot auto-resolve foreign-key columns as flat properties on
-- materialized views, so `/api/clusters/rollup` and `/api/families/[clusterId]`
-- have been 500'ing in production ever since commit 0daaaba switched those
-- routes to select a `source_name` column that never existed on the MV
-- (see docs/ARCHITECTURE.md §3 on the three-layer model; sources are
-- evidence-layer and only reachable via the source_id foreign key).
--
-- This migration adds the join once at the MV level so every reader —
-- including the admin trace panel, families detail, and V3 cluster cards —
-- gets `source_name` without a second round-trip to the `sources` table.
--
-- Rebuild order (dependencies flow *into* mv_observation_current):
--   1. Drop mv_cluster_health_current (depends on mv_observation_current)
--   2. Drop mv_trend_daily           (depends on mv_observation_current)
--   3. Drop mv_observation_current
--   4. Recreate mv_observation_current with `left join sources` + indexes
--   5. Recreate mv_trend_daily + index
--   6. Recreate mv_cluster_health_current + indexes
--   7. Initial populate of all three
--
-- The column list, CTE structure, and downstream MV definitions are copied
-- verbatim from scripts 013 (mv_observation_current, mv_trend_daily) and
-- 016 (mv_cluster_health_current); the ONLY change is adding the
-- `left join sources s` and `s.name as source_name` to mv_observation_current.
-- Keeping the copies explicit means future readers of this file see the
-- complete shape without having to cross-reference two other migrations.
--
-- Ops note: step 4's initial populate scales with observations-table size
-- and can take several seconds on prod. The rest of the pipeline can keep
-- serving 5xx on the affected routes until this completes (no worse than
-- current state — they are already 500'ing).
-- ============================================================================

begin;

drop materialized view if exists mv_cluster_health_current cascade;
drop materialized view if exists mv_trend_daily cascade;
drop materialized view if exists mv_observation_current cascade;

create materialized view mv_observation_current as
with latest_sentiment as (
  select distinct on (observation_id) observation_id, score, label, keyword_presence, algorithm_version, computed_at
  from sentiment_scores order by observation_id, computed_at desc
),
latest_category as (
  select distinct on (observation_id) observation_id, category_id, confidence, algorithm_version, computed_at
  from category_assignments order by observation_id, computed_at desc
),
latest_impact as (
  select distinct on (observation_id) observation_id, score, inputs_jsonb, algorithm_version, computed_at
  from impact_scores order by observation_id, computed_at desc
),
latest_engagement as (
  select distinct on (observation_id) observation_id, upvotes, comments_count, captured_at
  from engagement_snapshots order by observation_id, captured_at desc
),
latest_fingerprint as (
  select distinct on (observation_id)
    observation_id,
    error_code,
    top_stack_frame,
    top_stack_frame_hash,
    cli_version,
    os,
    shell,
    editor,
    model_id,
    repro_markers,
    keyword_presence as fp_keyword_presence,
    cluster_key_compound,
    algorithm_version as fingerprint_algorithm_version,
    computed_at as fingerprint_computed_at
  from bug_fingerprints
    order by observation_id, computed_at desc, algorithm_version desc
),
latest_classification as (
  select distinct on (observation_id)
    observation_id,
    subcategory as llm_subcategory,
    tags[1] as llm_primary_tag,
    category as llm_category,
    severity as llm_severity,
    confidence as llm_confidence,
    model_used as llm_model_used,
    created_at as llm_classified_at
  from classifications
    where observation_id is not null
    order by observation_id, created_at desc
)
select
  o.id as observation_id,
  o.source_id,
  s.name as source_name,
  o.external_id,
  o.title,
  o.content,
  o.url,
  o.author,
  o.published_at,
  o.captured_at,
  c.id as cluster_id,
  c.cluster_key,
  (c.canonical_observation_id = o.id) as is_canonical,
  cf.frequency_count,
  c.label as cluster_label,
  c.label_rationale as cluster_label_rationale,
  c.label_confidence as cluster_label_confidence,
  c.label_model as cluster_label_model,
  c.label_algorithm_version as cluster_label_algorithm_version,
  ls.label as sentiment,
  ls.score as sentiment_score,
  lc.category_id,
  li.score as impact_score,
  le.upvotes,
  le.comments_count,
  lf.error_code,
  lf.top_stack_frame,
  lf.top_stack_frame_hash,
  lf.cli_version,
  lf.os as fp_os,
  lf.shell as fp_shell,
  lf.editor as fp_editor,
  lf.model_id,
  lf.repro_markers,
  lf.fp_keyword_presence,
  lf.cluster_key_compound,
  lf.fingerprint_algorithm_version,
  lx.llm_subcategory,
  lx.llm_primary_tag,
  lx.llm_category,
  lx.llm_severity,
  lx.llm_confidence,
  lx.llm_model_used,
  lx.llm_classified_at
from observations o
left join sources s on s.id = o.source_id
left join cluster_members cm on cm.observation_id = o.id and cm.detached_at is null
left join clusters c on c.id = cm.cluster_id
left join cluster_frequency cf on cf.cluster_id = c.id
left join latest_sentiment ls on ls.observation_id = o.id
left join latest_category lc on lc.observation_id = o.id
left join latest_impact li on li.observation_id = o.id
left join latest_engagement le on le.observation_id = o.id
left join latest_fingerprint lf on lf.observation_id = o.id
left join latest_classification lx on lx.observation_id = o.id;

create unique index idx_mv_observation_current_pk on mv_observation_current (observation_id);
create index idx_mv_observation_current_canonical on mv_observation_current (is_canonical, published_at desc);
create index idx_mv_observation_current_cluster on mv_observation_current (cluster_id);
create index idx_mv_observation_current_error_code
  on mv_observation_current (error_code) where error_code is not null;
create index idx_mv_observation_current_frame_hash
  on mv_observation_current (top_stack_frame_hash) where top_stack_frame_hash is not null;

create materialized view mv_trend_daily as
select
  date_trunc('day', published_at) as day,
  sentiment,
  count(*) as cnt
from mv_observation_current
where is_canonical
  and published_at is not null
  and published_at >= now() - interval '30 days'
group by date_trunc('day', published_at), sentiment;

create index idx_mv_trend_daily_day on mv_trend_daily (day desc, sentiment);

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

commit;
