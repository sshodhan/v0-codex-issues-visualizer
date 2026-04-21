-- ============================================================================
-- Migration 009: time-bounded read functions for replayability
--
-- Implements the replayability contract described in docs/ARCHITECTURE.md
-- v10 §§7.4. /api/stats?as_of=<ISO8601> calls observation_current_as_of(ts)
-- to reconstruct what the dashboard would have shown at that time.
--
-- The semantics:
--  - Derivation rows are filtered to computed_at <= ts. For each
--    observation, the latest qualifying version is chosen (max computed_at).
--  - Cluster membership is filtered to attached_at <= ts AND
--    (detached_at IS NULL OR detached_at > ts).
--  - Engagement snapshots are filtered to captured_at <= ts; the latest
--    qualifying row per observation wins.
--  - Observations are filtered to captured_at <= ts (an observation
--    captured after the as_of point never existed yet).
--
-- The function returns the same columns as mv_observation_current. Callers
-- can reuse any consumer of that view with minimal churn.
-- ============================================================================

begin;

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
    order by observation_id, computed_at desc
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
