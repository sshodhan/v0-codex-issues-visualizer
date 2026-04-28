-- ============================================================================
-- Migration 019: pin mv_observation_current to the highest sentiment
-- algorithm_version, and surface sentiment-side keyword_presence
--
-- Bug: scripts/018_…sql:44-46 picks the latest sentiment_scores row by
-- `computed_at desc` only. `sentiment_scores` has unique(observation_id,
-- algorithm_version) (scripts/007_three_layer_split.sql:507) so v1 and v2
-- rows coexist by design. When v2 was never written for an observation
-- (no re-ingest, no admin backfill), the MV surfaces the v1 label even
-- though CURRENT_VERSIONS.sentiment = "v2" (lib/storage/algorithm-versions.ts).
-- Concrete failure: microsoft/vscode#312633 ("VSCode Terminal bug") rendered
-- "Positive" on the dashboard while the v2 heuristic returns "neutral" for
-- the same body (verified in lib/scrapers/shared.test.ts patterns).
--
-- Fix: put `algorithm_version desc` FIRST in the latest_sentiment ORDER BY
-- so the highest version always wins, regardless of `computed_at` skew
-- between live ingest writes and admin backfill writes. This is stricter
-- than latest_fingerprint's `computed_at desc, algorithm_version desc`
-- (scripts/018_…sql:77), which is fine: bug_fingerprints has a single
-- live version (v1), while sentiment is the only derivation with a real
-- v1↔v2 split today (lib/storage/algorithm-versions.ts:10).
--
-- Also expose the sentiment-side `keyword_presence` as
-- `sentiment_keyword_presence` so the issues-table badge can render a
-- topic-negative ("Issue") pill for polarity-neutral rows whose body still
-- matches NEGATIVE_KEYWORD_PATTERNS (lib/scrapers/shared.ts:6-17). The
-- existing `fp_keyword_presence` is a separate signal sourced from
-- bug_fingerprints (different regex set, different cadence), and is kept
-- as-is.
--
-- The same `latest_sentiment` bug exists in the time-bounded read RPC
-- `observation_current_as_of(ts)` (scripts/009_as_of_functions.sql:62-67);
-- this migration replaces that function too. The as_of CTE keeps its
-- existing `computed_at <= ts` filter, so any version that didn't yet
-- exist at `ts` is excluded before the algorithm_version sort runs — no
-- replay regressions.
--
-- Rebuild order mirrors scripts/018_…sql §15-22:
--   1. Drop mv_cluster_health_current (depends on mv_observation_current)
--   2. Drop mv_trend_daily            (depends on mv_observation_current)
--   3. Drop mv_observation_current
--   4. Recreate mv_observation_current with the corrected latest_sentiment
--      and the new sentiment_keyword_presence column
--   5. Recreate mv_trend_daily + index
--   6. Recreate mv_cluster_health_current + indexes
--   7. Replace observation_current_as_of(ts) with the same fix
--   8. Initial concurrent refresh of mv_observation_current so deployed
--      dashboards correct on the next page load instead of waiting on the
--      scheduled refresh
-- ============================================================================

begin;

drop materialized view if exists mv_cluster_health_current cascade;
drop materialized view if exists mv_trend_daily cascade;
drop materialized view if exists mv_observation_current cascade;

create materialized view mv_observation_current as
with latest_sentiment as (
  -- algorithm_version desc FIRST: v2 always wins over v1 when both rows
  -- exist for the same observation. computed_at desc is the in-version
  -- tiebreaker (the unique constraint forbids two rows at the same
  -- version, so the tiebreaker only matters across re-ingests of the
  -- same version, which currently can't happen because record_sentiment
  -- uses ON CONFLICT DO NOTHING — kept for forward-compat).
  select distinct on (observation_id) observation_id, score, label, keyword_presence, algorithm_version, computed_at
  from sentiment_scores order by observation_id, algorithm_version desc, computed_at desc
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
  ls.keyword_presence as sentiment_keyword_presence,
  ls.algorithm_version as sentiment_algorithm_version,
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

-- Replace the time-bounded read RPC with the same version-priority fix.
-- The existing `where computed_at <= ts` filter inside latest_sentiment
-- continues to exclude any row that didn't yet exist at `ts`, so a
-- pre-v2 `as_of` correctly returns v1 (v2 hasn't been written yet); a
-- post-v2 `as_of` returns v2 even if v1's computed_at was later. See the
-- replay regression test added in tests/replay.test.ts.
create or replace function observation_current_as_of(ts timestamptz)
returns table (
  observation_id uuid,
  source_id uuid,
  external_id text,
  title text,
  content text,
  url text,
  author text,
  published_at timestamptz,
  captured_at timestamptz,
  cluster_id uuid,
  cluster_key text,
  is_canonical boolean,
  frequency_count bigint,
  sentiment text,
  sentiment_score numeric,
  category_id uuid,
  impact_score int,
  upvotes int,
  comments_count int
)
language sql
stable
security definer
as $$
  with
  active_members as (
    select cm.cluster_id, cm.observation_id
    from cluster_members cm
    where cm.attached_at <= ts
      and (cm.detached_at is null or cm.detached_at > ts)
  ),
  frequency_by_cluster as (
    select cluster_id, count(*)::bigint as frequency_count
    from active_members
    group by cluster_id
  ),
  latest_sentiment as (
    select distinct on (observation_id)
      observation_id, score, label, algorithm_version, computed_at
    from sentiment_scores
    where computed_at <= ts
    order by observation_id, algorithm_version desc, computed_at desc
  ),
  latest_category as (
    select distinct on (observation_id)
      observation_id, category_id, algorithm_version, computed_at
    from category_assignments
    where computed_at <= ts
    order by observation_id, computed_at desc
  ),
  latest_impact as (
    select distinct on (observation_id)
      observation_id, score, algorithm_version, computed_at
    from impact_scores
    where computed_at <= ts
    order by observation_id, computed_at desc
  ),
  latest_engagement as (
    select distinct on (observation_id)
      observation_id, upvotes, comments_count, captured_at
    from engagement_snapshots
    where captured_at <= ts
    order by observation_id, captured_at desc
  )
  select
    o.id as observation_id,
    o.source_id,
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
    fbc.frequency_count,
    ls.label as sentiment,
    ls.score as sentiment_score,
    lc.category_id,
    li.score as impact_score,
    le.upvotes,
    le.comments_count
  from observations o
  left join active_members am on am.observation_id = o.id
  left join clusters c on c.id = am.cluster_id
  left join frequency_by_cluster fbc on fbc.cluster_id = c.id
  left join latest_sentiment ls on ls.observation_id = o.id
  left join latest_category lc on lc.observation_id = o.id
  left join latest_impact li on li.observation_id = o.id
  left join latest_engagement le on le.observation_id = o.id
  where o.captured_at <= ts;
$$;

grant execute on function observation_current_as_of(timestamptz) to anon, authenticated, service_role;

commit;

-- One-time refresh outside the transaction so deployed dashboards re-pick
-- v2 sentiment rows immediately. The unique pkey index on
-- observation_id (created above) gates the concurrent refresh.
refresh materialized view concurrently mv_observation_current;
refresh materialized view mv_trend_daily;
refresh materialized view mv_cluster_health_current;
