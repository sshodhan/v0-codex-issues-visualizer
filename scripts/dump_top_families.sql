-- scripts/dump_top_families.sql
--
-- One-shot diagnostic. Returns the rows that would render as cards in
-- "Top Families" on the dashboard, limited to 6 and trimmed to the
-- fields FamilyCard reads. Mirrors the relevant joins from
-- /api/clusters/rollup (clusters + mv_observation_current + canonical
-- observation + mv_cluster_health_current) so the output matches what
-- the UI shows, with two known caveats:
--
--   1. `rail_scoring.actionability_input` is computed in-process by
--      the rollup route, not in SQL, so it is omitted here. The mock
--      will render the Actionability bar from the per-cluster signals
--      we DO have (avg_impact + fingerprint_hit_rate + classified
--      coverage), or as "—" if eng prefers to see only ground truth.
--   2. FREQUENT/FIX FIRST badge assignments are computed client-side
--      against the top-6 set, so they're applied at render time, not
--      here.
--
-- Run in the Supabase SQL editor (or psql with `\copy`). Tweak the
-- window in the params CTE if you want a wider/narrower lookback.

with params as (
  select 30::int as window_days,
         null::text as category_slug  -- e.g. 'bug' to filter; null = all
),
window_obs as (
  select m.observation_id, m.cluster_id, m.title, m.source_name,
         m.impact_score, m.llm_classified_at, m.category_id
  from mv_observation_current m, params p
  where m.is_canonical
    and m.cluster_id is not null
    and (p.window_days is null
         or m.published_at >= now() - make_interval(days => p.window_days))
    and (
      p.category_slug is null
      or m.category_id in (
        select id from categories where slug = p.category_slug
      )
    )
),
per_cluster as (
  select
    cluster_id,
    count(*)::int                                              as obs_count,
    count(*) filter (where llm_classified_at is not null)::int as classified_count,
    count(distinct source_name)::int                           as source_count,
    avg(impact_score)::numeric(5,2)                            as avg_impact
  from window_obs
  group by cluster_id
)
select json_agg(row_to_json(t) order by t.count desc, t.id) as top_families
from (
  select
    pc.cluster_id                       as id,
    pc.obs_count                        as count,
    pc.classified_count,
    pc.source_count,
    pc.avg_impact,
    cl.label,
    cl.label_confidence,
    cl.label_model,
    o.title                             as representative_title,
    h.cluster_path,
    h.reviewed_count,
    h.fingerprint_hit_rate,
    h.dominant_error_code_share,
    h.dominant_stack_frame_share,
    h.intra_cluster_similarity_proxy,
    h.nearest_cluster_gap_proxy
  from per_cluster pc
  join clusters cl                       on cl.id = pc.cluster_id
  left join observations o               on o.id = cl.canonical_observation_id
  left join mv_cluster_health_current h  on h.cluster_id = pc.cluster_id
  order by pc.obs_count desc, pc.cluster_id
  limit 6
) t;
