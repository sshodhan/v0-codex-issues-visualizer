-- ============================================================================
-- Migration 010: performance indexes on mv_observation_current
--
-- 007 created the MV with only three indexes: (observation_id) PK,
-- (is_canonical, published_at desc), and (cluster_id). /api/issues allows
-- sorts on impact_score / upvotes / comments_count / sentiment_score /
-- captured_at (app/api/issues/route.ts), and its q= filter does
-- title.ilike.%q% OR content.ilike.%q%. Without these indexes every non-
-- default sort and every search falls back to a sequential scan of the full
-- canonical set.
--
-- 003 had put a trigram index on issues.content; 007 dropped that when the
-- issues table went away and did not recreate an equivalent. This migration
-- restores the trigram coverage on the MV's title + content columns.
--
-- All indexes are partial on is_canonical = true since every /api/issues
-- read filters that way; the smaller footprint keeps refresh costs low.
-- ============================================================================

begin;

create extension if not exists pg_trgm;

-- Sort columns used by /api/issues (app/api/issues/route.ts:5-12).
create index if not exists idx_mv_observation_current_impact
  on mv_observation_current (impact_score desc) where is_canonical;

create index if not exists idx_mv_observation_current_upvotes
  on mv_observation_current (upvotes desc) where is_canonical;

create index if not exists idx_mv_observation_current_comments
  on mv_observation_current (comments_count desc) where is_canonical;

create index if not exists idx_mv_observation_current_sentiment_score
  on mv_observation_current (sentiment_score desc) where is_canonical;

create index if not exists idx_mv_observation_current_captured_at
  on mv_observation_current (captured_at desc) where is_canonical;

-- Trigram coverage for q= substring search. Separate indexes on title and
-- content so the planner can choose either side of the OR cheaply.
create index if not exists idx_mv_observation_current_title_trgm
  on mv_observation_current using gin (title gin_trgm_ops) where is_canonical;

create index if not exists idx_mv_observation_current_content_trgm
  on mv_observation_current using gin (content gin_trgm_ops) where is_canonical;

commit;
