-- ============================================================================
-- Migration 030: Canonical URL second-tier dedup at scrape ingest
--
-- Problem
-- -------
-- The `observations` table dedups on `(source_id, external_id)`, which is
-- correct *within* a single submission stream — Hacker News issues a fresh
-- `objectID` for every story submission, so two HN submissions of the same
-- outbound article produce two rows with distinct `external_id`s. From HN's
-- perspective those ARE distinct stories; from our analytics perspective
-- they are the same content.
--
-- The downstream cost is real: duplicate posts share embeddings at cosine
-- ≈ 0.99, always semantic-cluster together, and create false 2-member
-- recurrence signals that consume review-queue capacity for non-events.
--
-- Fix
-- ---
-- 1) Persist a `canonical_url` alongside each observation, computed by the
--    TS-side helper in `lib/scrapers/url.ts`. Cosmetic differences (the
--    `www.` prefix, trailing slashes, tracking params, fragment) collapse
--    into a single string per piece of content.
-- 2) Add a non-unique index on `(source_id, canonical_url)`. The index is
--    diagnostic-only: it speeds up the scraper's pre-insert lookup but does
--    NOT enforce uniqueness at the DB layer, leaving room for the
--    application to record duplicate-attempts as audit signal rather than
--    silently dropping them.
-- 3) Extend the `record_observation` RPC to accept `canonical_url` in the
--    JSONB payload so the existing append-only invariant is preserved.
-- 4) Add a `duplicate_observation_events` audit table that captures every
--    re-submission attempt (different external_id, same canonical_url) so
--    the dedup is visible to operators and can later be promoted into a
--    "community interest" signal.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) Schema changes
-- ----------------------------------------------------------------------------

alter table observations
  add column if not exists canonical_url text;

create index if not exists idx_observations_source_canonical_url
  on observations (source_id, canonical_url)
  where canonical_url is not null;

-- ----------------------------------------------------------------------------
-- 2) Audit table for duplicate-resubmission events
--
-- Append-only. Each row records a single "we saw this canonical URL again
-- under a fresh external_id and chose not to insert" decision. Operators can
-- query this to estimate the volume of cross-stream re-submissions per
-- source, and a later migration can promote it into a `duplicate_of`
-- pointer on `observations` if we decide to keep duplicate rows for trend
-- weighting (see Caveats in the issue description).
-- ----------------------------------------------------------------------------

create table if not exists duplicate_observation_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  canonical_url text not null,
  duplicate_external_id text not null,
  canonical_observation_id uuid not null references observations(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_duplicate_observation_events_canonical
  on duplicate_observation_events (canonical_observation_id, created_at desc);

create index if not exists idx_duplicate_observation_events_source_created
  on duplicate_observation_events (source_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 3) RPC: extend record_observation to persist canonical_url
--
-- Signature is unchanged (still `record_observation(jsonb) returns uuid`),
-- so existing callers that don't yet send canonical_url keep working — the
-- column is left null, and the diagnostic index ignores null rows.
-- ----------------------------------------------------------------------------

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
  insert into observations (
    source_id, external_id, title, content, url, canonical_url,
    author, published_at
  )
  values (
    src_id,
    ext_id,
    payload->>'title',
    payload->>'content',
    payload->>'url',
    payload->>'canonical_url',
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

commit;
