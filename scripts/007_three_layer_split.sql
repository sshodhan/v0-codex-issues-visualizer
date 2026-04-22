-- ============================================================================
-- Migration 007: Three-layer data model split
--
-- Replaces the monolithic `issues` table and the reviewer-mutable
-- `bug_report_classifications` table with three strictly separated layers:
--
--   Evidence   — append-only raw capture from public sources
--   Derivation — versioned, immutable per-algorithm outputs
--   Aggregation — clusters and materialized views that feed the dashboard
--
-- See docs/ARCHITECTURE.md v10 §§3, 5.
--
-- This migration assumes user has authorized a full repull (no data is
-- preserved from the old `issues` / `bug_report_classifications` tables).
-- Run in a transaction.
--
-- Safe to apply on either (a) a fresh database or (b) a database previously
-- seeded by 001–006 ("original setup"). The cleanup block below drops legacy
-- policies on `sources`, `categories`, and `scrape_logs` that survive the
-- cutover (the tables themselves are not dropped, so their 002-era policies
-- would otherwise collide with the new `public_read_*` names created in the
-- RLS section at the bottom of this file).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0) Legacy policy cleanup (001/002 artifacts on reference tables)
--
-- 001 created policies like "Allow public read sources" and
-- "Service role full access sources"; 002 replaced those with
-- "public_read_sources" + "service_insert_sources"/"service_update_sources"/
-- "service_delete_sources". Tables `sources`, `categories`, `scrape_logs` are
-- kept across the cutover, so their policies are not dropped by the
-- `drop table` calls below and must be removed explicitly before the RLS
-- block re-creates a `public_read_*` family under the same names.
-- ----------------------------------------------------------------------------

drop policy if exists "Allow public read sources" on sources;
drop policy if exists "Allow public read categories" on categories;
drop policy if exists "Allow public read scrape_logs" on scrape_logs;
drop policy if exists "Service role full access sources" on sources;
drop policy if exists "Service role full access categories" on categories;
drop policy if exists "Service role full access scrape_logs" on scrape_logs;

drop policy if exists "public_read_sources" on sources;
drop policy if exists "public_read_categories" on categories;
drop policy if exists "public_read_scrape_logs" on scrape_logs;

drop policy if exists "service_insert_sources" on sources;
drop policy if exists "service_update_sources" on sources;
drop policy if exists "service_delete_sources" on sources;
drop policy if exists "service_insert_categories" on categories;
drop policy if exists "service_update_categories" on categories;
drop policy if exists "service_delete_categories" on categories;
drop policy if exists "service_insert_scrape_logs" on scrape_logs;
drop policy if exists "service_update_scrape_logs" on scrape_logs;
drop policy if exists "service_delete_scrape_logs" on scrape_logs;

-- ----------------------------------------------------------------------------
-- 1) Drop old objects (clean slate)
-- ----------------------------------------------------------------------------

drop materialized view if exists mv_observation_current cascade;
drop materialized view if exists mv_dashboard_stats cascade;
drop materialized view if exists mv_trend_daily cascade;

drop function if exists upsert_issue_observation(jsonb) cascade;
drop function if exists increment_canonical_frequency(uuid) cascade;
drop function if exists refresh_materialized_views() cascade;
drop function if exists record_observation(jsonb) cascade;
drop function if exists record_observation_revision(uuid, jsonb) cascade;
drop function if exists record_engagement_snapshot(uuid, int, int) cascade;
drop function if exists record_ingestion_artifact(uuid, text, timestamptz, jsonb) cascade;
drop function if exists record_sentiment(uuid, text, numeric, text, int, timestamptz) cascade;
drop function if exists record_category(uuid, text, uuid, numeric, timestamptz) cascade;
drop function if exists record_impact(uuid, text, int, jsonb, timestamptz) cascade;
drop function if exists record_competitor_mention(uuid, text, text, numeric, numeric, text, text, timestamptz) cascade;
drop function if exists record_classification(jsonb) cascade;
drop function if exists record_classification_review(uuid, jsonb) cascade;
drop function if exists attach_to_cluster(uuid, text) cascade;
drop function if exists detach_from_cluster(uuid) cascade;

drop table if exists bug_report_classifications cascade;
drop table if exists issues cascade;

-- Reference tables kept; recreate only if absent.

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  icon text,
  base_url text,
  created_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  color text not null default '#6366f1',
  created_at timestamptz not null default now()
);

create table if not exists scrape_logs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources(id) on delete cascade,
  status text not null check (status in ('pending','running','completed','failed')),
  issues_found int not null default 0,
  issues_added int not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

-- ----------------------------------------------------------------------------
-- 2) Algorithm version registry
-- ----------------------------------------------------------------------------

create table if not exists algorithm_versions (
  kind text not null check (kind in ('sentiment','category','impact','competitor_mention','classification')),
  version text not null,
  current_effective boolean not null default false,
  released_at timestamptz not null default now(),
  notes text,
  primary key (kind, version)
);

create unique index if not exists idx_algorithm_versions_one_current
  on algorithm_versions(kind) where current_effective;

insert into algorithm_versions(kind, version, current_effective, notes) values
  ('sentiment', 'v1', true, 'Canonical lexicon tokenized whole-word match (PR #10)'),
  ('category',  'v1', true, 'Weighted phrase matching with whole-word mode'),
  ('impact',    'v1', true, 'Engagement x sentiment (PR #11: 1.5x negative boost)'),
  ('competitor_mention', 'v1', true, 'Mention-window sentiment with null-no-evidence (PR #11 v8)'),
  ('classification',     'v1', true, 'OpenAI Responses API, strict JSON schema, temp 0.2')
on conflict do nothing;

-- ============================================================================
-- Evidence layer — append-only, never UPDATE
-- ============================================================================

create table observations (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete restrict,
  external_id text not null,
  title text not null,
  content text,
  url text,
  author text,
  published_at timestamptz,
  captured_at timestamptz not null default now(),
  unique (source_id, external_id)
);
create index idx_observations_published_at on observations (published_at desc);
create index idx_observations_captured_at on observations (captured_at desc);
create index idx_observations_source on observations (source_id);

create table observation_revisions (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  revision_number int not null,
  title text,
  content text,
  author text,
  seen_at timestamptz not null default now(),
  unique (observation_id, revision_number)
);
create index idx_observation_revisions_obs on observation_revisions (observation_id, revision_number desc);

create table engagement_snapshots (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  upvotes int not null default 0,
  comments_count int not null default 0,
  captured_at timestamptz not null default now()
);
create index idx_engagement_snapshots_latest on engagement_snapshots (observation_id, captured_at desc);

create table ingestion_artifacts (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete restrict,
  external_id text not null,
  fetched_at timestamptz not null default now(),
  payload jsonb not null,
  unique (source_id, external_id, fetched_at)
);
create index idx_ingestion_artifacts_lookup on ingestion_artifacts (source_id, external_id, fetched_at desc);

-- ============================================================================
-- Derivation layer — versioned, immutable
-- ============================================================================

create table sentiment_scores (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  algorithm_version text not null,
  score numeric(4,3) not null check (score between -1 and 1),
  label text not null check (label in ('positive','negative','neutral')),
  keyword_presence int not null default 0,
  computed_at timestamptz not null default now(),
  unique (observation_id, algorithm_version)
);
create index idx_sentiment_latest on sentiment_scores (observation_id, computed_at desc);

create table category_assignments (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  algorithm_version text not null,
  category_id uuid not null references categories(id) on delete restrict,
  confidence numeric(3,2) not null default 0,
  computed_at timestamptz not null default now(),
  unique (observation_id, algorithm_version)
);
create index idx_category_latest on category_assignments (observation_id, computed_at desc);

create table impact_scores (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  algorithm_version text not null,
  score int not null check (score between 1 and 10),
  inputs_jsonb jsonb not null,
  computed_at timestamptz not null default now(),
  unique (observation_id, algorithm_version)
);
create index idx_impact_latest on impact_scores (observation_id, computed_at desc);

create table competitor_mentions (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  competitor text not null,
  sentence_window text,
  sentiment_score numeric(4,3),
  confidence numeric(3,2),
  lexicon_version text not null,
  algorithm_version text not null,
  computed_at timestamptz not null default now()
);
create index idx_competitor_mentions_obs on competitor_mentions (observation_id);
create index idx_competitor_mentions_roll on competitor_mentions (competitor, computed_at desc);

create table classifications (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid references observations(id) on delete restrict,
  prior_classification_id uuid references classifications(id) on delete restrict,
  report_text text not null,
  category text not null,
  subcategory text not null,
  severity text not null,
  status text not null,
  reproducibility text not null,
  impact text not null,
  confidence numeric(3,2) not null,
  summary text not null,
  root_cause_hypothesis text not null,
  suggested_fix text not null,
  evidence_quotes text[] not null default '{}',
  alternate_categories text[] not null default '{}',
  tags text[] not null default '{}',
  needs_human_review boolean not null,
  review_reasons text[] not null default '{}',
  model_used text,
  retried_with_large_model boolean not null default false,
  algorithm_version text not null,
  raw_json jsonb not null,
  created_at timestamptz not null default now()
);
create index idx_classifications_obs on classifications (observation_id, created_at desc);
create index idx_classifications_triage on classifications (category, severity, needs_human_review, created_at desc);
create index idx_classifications_prior on classifications (prior_classification_id);

create table classification_reviews (
  id uuid primary key default gen_random_uuid(),
  classification_id uuid not null references classifications(id) on delete restrict,
  status text,
  category text,
  severity text,
  needs_human_review boolean,
  reviewer_notes text,
  reviewed_by text not null,
  reviewed_at timestamptz not null default now()
);
create index idx_classification_reviews_latest on classification_reviews (classification_id, reviewed_at desc);

-- ============================================================================
-- Aggregation layer
-- ============================================================================

create table clusters (
  id uuid primary key default gen_random_uuid(),
  cluster_key text not null unique,
  canonical_observation_id uuid not null references observations(id) on delete restrict,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table cluster_members (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid not null references clusters(id) on delete restrict,
  observation_id uuid not null references observations(id) on delete restrict,
  attached_at timestamptz not null default now(),
  detached_at timestamptz
);
create unique index idx_cluster_members_active
  on cluster_members (cluster_id, observation_id) where detached_at is null;
create index idx_cluster_members_obs on cluster_members (observation_id) where detached_at is null;

create view cluster_frequency as
  select cluster_id, count(*) as frequency_count
  from cluster_members where detached_at is null
  group by cluster_id;

-- ============================================================================
-- Materialized views — rebuilt on cron end, never mutated in place
-- ============================================================================

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
  cf.frequency_count,
  ls.label as sentiment,
  ls.score as sentiment_score,
  lc.category_id,
  li.score as impact_score,
  le.upvotes,
  le.comments_count
from observations o
left join cluster_members cm on cm.observation_id = o.id and cm.detached_at is null
left join clusters c on c.id = cm.cluster_id
left join cluster_frequency cf on cf.cluster_id = c.id
left join latest_sentiment ls on ls.observation_id = o.id
left join latest_category lc on lc.observation_id = o.id
left join latest_impact li on li.observation_id = o.id
left join latest_engagement le on le.observation_id = o.id;

create unique index idx_mv_observation_current_pk on mv_observation_current (observation_id);
create index idx_mv_observation_current_canonical on mv_observation_current (is_canonical, published_at desc);
create index idx_mv_observation_current_cluster on mv_observation_current (cluster_id);

-- mv_dashboard_stats was created here in an earlier revision as a
-- pre-aggregated shortcut for /api/stats, but /api/stats never read it —
-- the route scans mv_observation_current directly for the richer fields
-- (category/sentiment breakdown, priority matrix, realtime insights,
-- competitive mentions) and computes the simple aggregates in the same
-- loop. Rebuilding a second MV every cron saved nothing and added
-- refresh cost, so it's dropped. The defensive
-- `drop materialized view if exists mv_dashboard_stats cascade` at the
-- top of this file still runs in case an earlier revision of 007 was
-- applied to a DB.

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

-- ============================================================================
-- RPCs — the only write surface for service_role
-- ============================================================================

create or replace function refresh_materialized_views()
returns void
language plpgsql
security definer
as $$
begin
  refresh materialized view concurrently mv_observation_current;
  refresh materialized view mv_trend_daily;
end;
$$;
grant execute on function refresh_materialized_views() to service_role;

create or replace function record_observation(payload jsonb)
returns uuid
language plpgsql
security definer
as $$
declare
  obs_id uuid;
  src_id uuid := (payload->>'source_id')::uuid;
  ext_id text := payload->>'external_id';
begin
  -- Pure insert or no-op: existing evidence rows are never modified.
  -- Title/content changes on rescrape land in observation_revisions via
  -- record_observation_revision, not here.
  insert into observations (source_id, external_id, title, content, url, author, published_at)
  values (
    src_id,
    ext_id,
    payload->>'title',
    payload->>'content',
    payload->>'url',
    payload->>'author',
    nullif(payload->>'published_at','')::timestamptz
  )
  on conflict (source_id, external_id) do nothing
  returning id into obs_id;

  if obs_id is null then
    select id into obs_id from observations where source_id = src_id and external_id = ext_id;
  end if;
  return obs_id;
end;
$$;
grant execute on function record_observation(jsonb) to service_role;

create or replace function record_observation_revision(obs_id uuid, payload jsonb)
returns uuid
language plpgsql
security definer
as $$
declare
  next_rev int;
  rev_id uuid;
begin
  select coalesce(max(revision_number), 0) + 1 into next_rev
  from observation_revisions where observation_id = obs_id;

  insert into observation_revisions (observation_id, revision_number, title, content, author)
  values (obs_id, next_rev, payload->>'title', payload->>'content', payload->>'author')
  returning id into rev_id;
  return rev_id;
end;
$$;
grant execute on function record_observation_revision(uuid, jsonb) to service_role;

create or replace function record_engagement_snapshot(obs_id uuid, upv int, cmts int)
returns uuid
language plpgsql
security definer
as $$
declare snap_id uuid;
begin
  insert into engagement_snapshots (observation_id, upvotes, comments_count)
  values (obs_id, upv, cmts)
  returning id into snap_id;
  return snap_id;
end;
$$;
grant execute on function record_engagement_snapshot(uuid, int, int) to service_role;

create or replace function record_ingestion_artifact(src_id uuid, ext_id text, fetched timestamptz, data jsonb)
returns uuid
language plpgsql
security definer
as $$
declare art_id uuid;
begin
  insert into ingestion_artifacts (source_id, external_id, fetched_at, payload)
  values (src_id, ext_id, fetched, data)
  on conflict (source_id, external_id, fetched_at) do nothing
  returning id into art_id;
  return art_id;
end;
$$;
grant execute on function record_ingestion_artifact(uuid, text, timestamptz, jsonb) to service_role;

create or replace function record_sentiment(obs_id uuid, ver text, s numeric, lbl text, kp int)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into sentiment_scores (observation_id, algorithm_version, score, label, keyword_presence)
  values (obs_id, ver, s, lbl, kp)
  on conflict (observation_id, algorithm_version) do nothing
  returning id into row_id;
  return row_id;
end;
$$;
grant execute on function record_sentiment(uuid, text, numeric, text, int) to service_role;

create or replace function record_category(obs_id uuid, ver text, cat_id uuid, conf numeric)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into category_assignments (observation_id, algorithm_version, category_id, confidence)
  values (obs_id, ver, cat_id, conf)
  on conflict (observation_id, algorithm_version) do nothing
  returning id into row_id;
  return row_id;
end;
$$;
grant execute on function record_category(uuid, text, uuid, numeric) to service_role;

create or replace function record_impact(obs_id uuid, ver text, s int, inputs jsonb)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into impact_scores (observation_id, algorithm_version, score, inputs_jsonb)
  values (obs_id, ver, s, inputs)
  on conflict (observation_id, algorithm_version) do nothing
  returning id into row_id;
  return row_id;
end;
$$;
grant execute on function record_impact(uuid, text, int, jsonb) to service_role;

create or replace function record_competitor_mention(
  obs_id uuid, comp text, win_text text, sent numeric, conf numeric, lex_ver text, alg_ver text
) returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into competitor_mentions (observation_id, competitor, sentence_window, sentiment_score, confidence, lexicon_version, algorithm_version)
  values (obs_id, comp, win_text, sent, conf, lex_ver, alg_ver)
  returning id into row_id;
  return row_id;
end;
$$;
grant execute on function record_competitor_mention(uuid, text, text, numeric, numeric, text, text) to service_role;

create or replace function record_classification(payload jsonb)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into classifications (
    observation_id, prior_classification_id, report_text,
    category, subcategory, severity, status, reproducibility, impact,
    confidence, summary, root_cause_hypothesis, suggested_fix,
    evidence_quotes, alternate_categories, tags,
    needs_human_review, review_reasons,
    model_used, retried_with_large_model, algorithm_version, raw_json
  ) values (
    nullif(payload->>'observation_id','')::uuid,
    nullif(payload->>'prior_classification_id','')::uuid,
    payload->>'report_text',
    payload->>'category',
    payload->>'subcategory',
    payload->>'severity',
    payload->>'status',
    payload->>'reproducibility',
    payload->>'impact',
    (payload->>'confidence')::numeric,
    payload->>'summary',
    payload->>'root_cause_hypothesis',
    payload->>'suggested_fix',
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(payload->'evidence_quotes')), '{}'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(payload->'alternate_categories')), '{}'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(payload->'tags')), '{}'),
    (payload->>'needs_human_review')::boolean,
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(payload->'review_reasons')), '{}'),
    payload->>'model_used',
    coalesce((payload->>'retried_with_large_model')::boolean, false),
    payload->>'algorithm_version',
    payload->'raw_json'
  ) returning id into row_id;
  return row_id;
end;
$$;
grant execute on function record_classification(jsonb) to service_role;

create or replace function record_classification_review(cls_id uuid, payload jsonb)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into classification_reviews (
    classification_id, status, category, severity, needs_human_review,
    reviewer_notes, reviewed_by
  ) values (
    cls_id,
    payload->>'status',
    payload->>'category',
    payload->>'severity',
    nullif(payload->>'needs_human_review','')::boolean,
    payload->>'reviewer_notes',
    payload->>'reviewed_by'
  ) returning id into row_id;
  return row_id;
end;
$$;
grant execute on function record_classification_review(uuid, jsonb) to service_role;

create or replace function attach_to_cluster(obs_id uuid, key text)
returns uuid
language plpgsql
security definer
as $$
declare
  cluster_row uuid;
begin
  -- Atomic cluster upsert: inserter becomes canonical; racer sees existing row.
  insert into clusters (cluster_key, canonical_observation_id)
  values (key, obs_id)
  on conflict (cluster_key) do update set cluster_key = excluded.cluster_key
  returning id into cluster_row;

  -- Idempotent active membership insert guarded by the partial unique index.
  if not exists (
    select 1 from cluster_members
    where cluster_id = cluster_row and observation_id = obs_id and detached_at is null
  ) then
    insert into cluster_members (cluster_id, observation_id)
    values (cluster_row, obs_id);
  end if;

  return cluster_row;
end;
$$;
grant execute on function attach_to_cluster(uuid, text) to service_role;

create or replace function detach_from_cluster(obs_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  update cluster_members
     set detached_at = now()
   where observation_id = obs_id and detached_at is null;
end;
$$;
grant execute on function detach_from_cluster(uuid) to service_role;

-- ============================================================================
-- RLS — anon read everywhere; service_role writes only via RPCs above
-- ============================================================================

alter table sources enable row level security;
alter table categories enable row level security;
alter table scrape_logs enable row level security;
alter table algorithm_versions enable row level security;
alter table observations enable row level security;
alter table observation_revisions enable row level security;
alter table engagement_snapshots enable row level security;
alter table ingestion_artifacts enable row level security;
alter table sentiment_scores enable row level security;
alter table category_assignments enable row level security;
alter table impact_scores enable row level security;
alter table competitor_mentions enable row level security;
alter table classifications enable row level security;
alter table classification_reviews enable row level security;
alter table clusters enable row level security;
alter table cluster_members enable row level security;

-- Public read on everything (dashboard is a public-read app).
do $$
declare t text;
begin
  for t in select unnest(array[
    'sources','categories','scrape_logs','algorithm_versions',
    'observations','observation_revisions','engagement_snapshots','ingestion_artifacts',
    'sentiment_scores','category_assignments','impact_scores','competitor_mentions',
    'classifications','classification_reviews',
    'clusters','cluster_members'
  ]) loop
    execute format('create policy "public_read_%1$s" on %1$I for select to anon, authenticated using (true);', t);
  end loop;
end $$;

-- service_role may UPDATE/INSERT/DELETE only on reference + scrape_logs tables
-- plus clusters/cluster_members (aggregation rebuilds). Evidence, derivation,
-- and classifications are reachable only via the RPCs above (SECURITY DEFINER).
create policy "service_rw_sources" on sources for all to service_role using (true) with check (true);
create policy "service_rw_categories" on categories for all to service_role using (true) with check (true);
create policy "service_rw_scrape_logs" on scrape_logs for all to service_role using (true) with check (true);
create policy "service_rw_algorithm_versions" on algorithm_versions for all to service_role using (true) with check (true);
create policy "service_rw_clusters" on clusters for all to service_role using (true) with check (true);
create policy "service_rw_cluster_members" on cluster_members for all to service_role using (true) with check (true);

-- Evidence + derivation + classifications: NO direct service_role write
-- policy. Writes must go through SECURITY DEFINER RPCs, which bypass RLS.
-- This is what makes the append-only invariant enforceable at the DB layer.

-- ----------------------------------------------------------------------------
-- Seed reference data (sources + categories)
-- ----------------------------------------------------------------------------

insert into sources (name, slug, icon, base_url) values
  ('Reddit', 'reddit', 'MessageSquare', 'https://reddit.com'),
  ('Hacker News', 'hackernews', 'Newspaper', 'https://news.ycombinator.com'),
  ('GitHub', 'github', 'Github', 'https://github.com'),
  ('GitHub Discussions', 'github-discussions', 'Github', 'https://github.com'),
  ('Stack Overflow', 'stackoverflow', 'MessageSquare', 'https://stackoverflow.com'),
  ('OpenAI Community', 'openai-community', 'MessageSquare', 'https://community.openai.com')
on conflict (slug) do nothing;

insert into categories (name, slug, color) values
  ('Performance', 'performance', '#ef4444'),
  ('Bug', 'bug', '#f97316'),
  ('Feature Request', 'feature-request', '#8b5cf6'),
  ('Documentation', 'documentation', '#06b6d4'),
  ('Integration', 'integration', '#10b981'),
  ('Pricing', 'pricing', '#f59e0b'),
  ('Security', 'security', '#dc2626'),
  ('UX/UI', 'ux-ui', '#ec4899'),
  ('API', 'api', '#3b82f6'),
  ('Other', 'other', '#6b7280')
on conflict (slug) do nothing;

commit;
