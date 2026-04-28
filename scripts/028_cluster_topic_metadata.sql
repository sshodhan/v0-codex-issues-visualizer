-- 028_cluster_topic_metadata.sql
--
-- Layer A (semantic cluster) topic metadata read model.
--
-- Layer 0 = the heuristic Topic classifier (lib/scrapers/shared.ts →
-- categorizeIssue, persisted into category_assignments with the v5
-- structured `evidence` JSONB added by scripts/026; v6 bumped the
-- phrase table without changing the evidence shape, see
-- scripts/027_topic_classifier_v6_bump.sql). It is and remains
-- observation-level: one Topic decision per (observation_id,
-- algorithm_version) tuple.
--
-- Layer A = the semantic cluster (clusters + cluster_members), built
-- embedding-first by lib/storage/semantic-clusters.ts. Membership is
-- decided by cosine similarity over OpenAI embeddings, NOT by the Topic
-- slug. This view does not change that — it joins the per-observation
-- Topic decisions back onto each cluster as an *aggregated explanatory
-- signal* so admins can answer:
--
--   * which Topic dominates the cluster?
--   * is the cluster genuinely homogeneous (one Topic), mixed
--     (multiple Topics with non-trivial share), or low-confidence
--     (many low-margin assignments)?
--   * which matched phrases recur across the cluster's evidence?
--
-- Producer/consumer split:
--   * Producer = lib/scrapers/shared.ts (writes evidence, unchanged).
--   * Consumer = this view + lib/storage/cluster-topic-metadata.ts
--     (reads aggregates, no write path).
--
-- This is **not** a clustering gate. The embedding pass still owns
-- membership; high `mixed_topic_score` is a hint for human review, not
-- an automatic split. See docs/CLUSTERING_DESIGN.md §4.6.
--
-- Companion to 026 (evidence column). Apply order: 007, 012, 016, 026,
-- 027 (Topic v6 bump), then 028.

begin;

drop materialized view if exists mv_cluster_topic_metadata cascade;

create materialized view mv_cluster_topic_metadata as
with active_members as (
  -- Live cluster membership snapshot (active = detached_at IS NULL).
  -- Mirrors the predicate used by `cluster_frequency` and
  -- `mv_cluster_health_current`.
  select
    cm.cluster_id,
    cm.observation_id
  from cluster_members cm
  where cm.detached_at is null
),
current_topic_version as (
  -- Single-row CTE that resolves to whatever Topic algorithm version is
  -- `current_effective` in algorithm_versions. v5 introduced the
  -- structured `evidence` JSONB; v6 added phrases without changing the
  -- shape; future bumps that preserve the shape will be picked up
  -- automatically. A bump that changes the shape MUST also rev this
  -- view (see docs/CLUSTERING_DESIGN.md §4.6).
  select version
  from algorithm_versions
  where kind = 'category' and current_effective
  limit 1
),
latest_category_current as (
  -- Pin to the current Topic version's derivation rows (the ones that
  -- carry the structured `evidence` JSONB; pre-v5 rows have NULL
  -- evidence and would otherwise skew aggregates with NULL margins).
  -- `distinct on` picks the latest per observation in case multiple
  -- rows exist for the current version.
  select distinct on (ca.observation_id)
    ca.observation_id,
    ca.category_id,
    ca.confidence,
    ca.evidence,
    ca.algorithm_version,
    ca.computed_at
  from category_assignments ca, current_topic_version ctv
  where ca.algorithm_version = ctv.version
  order by ca.observation_id, ca.computed_at desc
),
member_topic as (
  -- One row per (cluster, observation) joined to its latest Topic
  -- decision at the current algorithm version (if any) and the
  -- categories.slug it points to.
  select
    am.cluster_id,
    am.observation_id,
    cat.slug as topic_slug,
    -- evidence shape (see scripts/026 + lib/scrapers/shared.ts):
    --   evidence.scoring.{winner, runner_up, margin, confidence_proxy, scores}
    --   evidence.matched_phrases [{slug, phrase, location, weighted_score, ...}]
    nullif(lcv.evidence -> 'scoring' ->> 'runner_up', '')::text as runner_up_slug,
    nullif(lcv.evidence -> 'scoring' ->> 'margin', '')::numeric as topic_margin,
    nullif(lcv.evidence -> 'scoring' ->> 'confidence_proxy', '')::numeric as confidence_proxy,
    lcv.evidence -> 'matched_phrases' as matched_phrases
  from active_members am
  left join latest_category_current lcv on lcv.observation_id = am.observation_id
  left join categories cat on cat.id = lcv.category_id
),
topic_counts as (
  -- Per (cluster, slug) frequency. NULL slug = observation has no v5
  -- Topic assignment yet; bucket it as 'unclassified' so the
  -- distribution is total-count-preserving.
  select
    cluster_id,
    coalesce(topic_slug, 'unclassified') as slug,
    count(*)::int as cnt
  from member_topic
  group by cluster_id, coalesce(topic_slug, 'unclassified')
),
runner_up_counts as (
  select
    cluster_id,
    runner_up_slug as slug,
    count(*)::int as cnt
  from member_topic
  where runner_up_slug is not null
  group by cluster_id, runner_up_slug
),
topic_distribution as (
  select
    cluster_id,
    jsonb_object_agg(slug, cnt) as topic_distribution
  from topic_counts
  group by cluster_id
),
runner_up_distribution as (
  select
    cluster_id,
    jsonb_object_agg(slug, cnt) as runner_up_distribution
  from runner_up_counts
  group by cluster_id
),
dominant_topic as (
  -- Pick the highest-count slug per cluster. Lex-tiebreak so the result
  -- is deterministic across runs and matches the `mode()` used by
  -- lib/storage/cluster-label-fallback.ts → composeDeterministicLabel.
  -- Excludes 'unclassified' from dominance unless it is the only bucket
  -- (a fully unclassified cluster reports unclassified as dominant —
  -- the share is then a useful "this cluster needs Layer 0 to run"
  -- signal).
  select distinct on (cluster_id)
    cluster_id,
    slug as dominant_topic_slug,
    cnt as dominant_topic_count
  from topic_counts
  order by
    cluster_id,
    case when slug = 'unclassified' then 1 else 0 end,
    cnt desc,
    slug asc
),
topic_aggregates as (
  -- Per-cluster numeric aggregates over the v5 evidence fields.
  -- AVG ignores NULLs natively; rows without an evidence margin
  -- (pre-v5 or unclassified observations) simply don't contribute.
  select
    cluster_id,
    count(*)::int as observation_count,
    count(topic_slug)::int as classified_count,
    avg(confidence_proxy)::numeric(6,4) as avg_confidence_proxy,
    avg(topic_margin)::numeric(6,4) as avg_topic_margin,
    count(*) filter (where topic_margin is not null and topic_margin <= 2)::int as low_margin_count
  from member_topic
  group by cluster_id
),
phrase_rows as (
  -- Flatten matched_phrases for cross-member phrase frequency. The
  -- evidence emitter (lib/scrapers/shared.ts → scoreSegment) tags each
  -- hit with the slug it scored under, and the same surface phrase can
  -- score for more than one slug now or after a future phrase-table
  -- maintenance pass — so aggregate by (cluster, slug, phrase) instead
  -- of collapsing on phrase alone. Keeps "X is evidence FOR <topic>"
  -- recoverable from the read model without a follow-up join.
  select
    mt.cluster_id,
    lower(coalesce(elem ->> 'slug', 'unknown')) as slug,
    lower(coalesce(elem ->> 'phrase', '')) as phrase
  from member_topic mt
  cross join lateral jsonb_array_elements(coalesce(mt.matched_phrases, '[]'::jsonb)) as elem
  where (elem ->> 'phrase') is not null and length(elem ->> 'phrase') > 0
),
phrase_counts as (
  select
    cluster_id,
    slug,
    phrase,
    count(*)::int as cnt
  from phrase_rows
  group by cluster_id, slug, phrase
),
phrase_ranked as (
  select
    cluster_id,
    slug,
    phrase,
    cnt,
    row_number() over (
      partition by cluster_id
      order by cnt desc, slug asc, phrase asc
    ) as rn
  from phrase_counts
),
common_phrases as (
  -- Top 10 per cluster, materialised as a JSONB array of
  -- {slug, phrase, count} objects so the read helper can surface them
  -- without further parsing.
  select
    cluster_id,
    jsonb_agg(
      jsonb_build_object('slug', slug, 'phrase', phrase, 'count', cnt)
      order by cnt desc, slug asc, phrase asc
    ) as common_matched_phrases
  from phrase_ranked
  where rn <= 10
  group by cluster_id
),
entropy_inputs as (
  -- Shannon entropy over the topic_distribution, normalised to [0, 1]
  -- by dividing by log(N) where N = number of distinct buckets in the
  -- cluster. 0 = single-topic; 1 = uniform across all observed buckets.
  -- Single-bucket clusters report 0 (log(1) = 0; we guard the divide).
  -- The "score" name follows mv_cluster_health_current's
  -- *_proxy/_score convention.
  select
    cluster_id,
    sum(cnt)::numeric as total,
    count(*)::int as bucket_count,
    sum(
      case
        when cnt > 0 then
          -((cnt::numeric / nullif(sum_cnt, 0)) * ln(cnt::numeric / nullif(sum_cnt, 0)))
        else 0
      end
    ) as entropy_nat
  from (
    select
      cluster_id,
      slug,
      cnt,
      sum(cnt) over (partition by cluster_id) as sum_cnt
    from topic_counts
  ) s
  group by cluster_id
)
select
  c.id as cluster_id,
  c.cluster_key,
  case
    when c.cluster_key like 'semantic:%' then 'semantic'
    else 'fallback'
  end::text as cluster_path,
  coalesce(ta.observation_count, 0) as observation_count,
  coalesce(ta.classified_count, 0) as classified_count,
  -- Members of the cluster that have no current-version Topic evidence
  -- yet. The name avoids collision with the categories.slug = 'other'
  -- bucket — that one is a real Topic decision, this is the count of
  -- observations the classifier has not yet (re-)processed.
  coalesce(ta.observation_count - ta.classified_count, 0) as unclassified_count,
  -- classified / observation, NUMERIC(5,4). Reviewers compare this to
  -- mixed_topic_score to tell mixed-topic-ness from missing-evidence —
  -- a high mixed_topic_score with low coverage is a Layer 0 backlog
  -- problem, not a Family that genuinely spans Topics.
  case
    when ta.observation_count > 0
      then (ta.classified_count::numeric / ta.observation_count::numeric)
    else 0::numeric
  end::numeric(5,4) as classification_coverage_share,
  coalesce(td.topic_distribution, '{}'::jsonb) as topic_distribution,
  coalesce(rud.runner_up_distribution, '{}'::jsonb) as runner_up_distribution,
  dt.dominant_topic_slug,
  dt.dominant_topic_count,
  case
    when ta.observation_count > 0
      then (dt.dominant_topic_count::numeric / ta.observation_count::numeric)
    else 0::numeric
  end::numeric(5,4) as dominant_topic_share,
  ta.avg_confidence_proxy,
  ta.avg_topic_margin,
  coalesce(ta.low_margin_count, 0) as low_margin_count,
  -- Normalised entropy. ln(bucket_count) is the natural-log denominator;
  -- when bucket_count <= 1 entropy is mechanically 0 and we short-circuit
  -- the division to avoid ln(1) = 0 → divide-by-zero. The `least(…, 1)`
  -- clamp guards the numeric(5,4) cast against a 1.0000…01 FP epsilon
  -- that uniform distributions can produce after the divide.
  -- NOTE: this score is computed over the full topic_distribution
  -- (including the 'unclassified' bucket), so a half-classified Family
  -- can read as "mixed" even when its classified half is one Topic.
  -- Use classification_coverage_share above to disambiguate.
  least(case
    when ei.bucket_count is null or ei.bucket_count <= 1 then 0::numeric
    else (ei.entropy_nat / ln(ei.bucket_count::numeric))
  end, 1::numeric)::numeric(5,4) as mixed_topic_score,
  coalesce(cp.common_matched_phrases, '[]'::jsonb) as common_matched_phrases,
  now() as computed_at
from clusters c
left join topic_aggregates ta on ta.cluster_id = c.id
left join topic_distribution td on td.cluster_id = c.id
left join runner_up_distribution rud on rud.cluster_id = c.id
left join dominant_topic dt on dt.cluster_id = c.id
left join entropy_inputs ei on ei.cluster_id = c.id
left join common_phrases cp on cp.cluster_id = c.id;

-- Unique index gates `REFRESH MATERIALIZED VIEW CONCURRENTLY`, matching
-- the pattern used by mv_cluster_health_current and mv_observation_current.
create unique index if not exists idx_mv_cluster_topic_metadata_cluster
  on mv_cluster_topic_metadata (cluster_id);

-- Secondary index for "show me the most-mixed clusters" admin queries.
create index if not exists idx_mv_cluster_topic_metadata_mixed
  on mv_cluster_topic_metadata (mixed_topic_score desc, observation_count desc);

-- Secondary index for "find clusters dominated by Topic X".
create index if not exists idx_mv_cluster_topic_metadata_dominant
  on mv_cluster_topic_metadata (dominant_topic_slug)
  where dominant_topic_slug is not null;

-- Wire the new MV into the central refresh hook so the cron tick that
-- already runs `refresh_materialized_views()` keeps it fresh alongside
-- the others. The unique index on cluster_id above gates concurrent
-- refresh, so refreshes do not take an exclusive lock on the MV — at
-- the cost of one extra full scan per refresh. mv_trend_daily,
-- mv_fingerprint_daily, and mv_cluster_health_current stay
-- non-concurrent here; matching them on this MV is a separate
-- discussion (their tradeoff hasn't been re-evaluated since 016).
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
  refresh materialized view concurrently mv_cluster_topic_metadata;
end;
$$;

grant execute on function refresh_materialized_views() to service_role;

commit;
