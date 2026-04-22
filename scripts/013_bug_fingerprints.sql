-- ============================================================================
-- Migration 013: Bug-fingerprint derivation + MV rewire
--
-- Adds a fourth derivation column to the three-layer model (sentiment,
-- category, impact, fingerprint) and an MV surface so dashboards can show
-- concrete differentiators — error codes, stack frames, env tokens, repro
-- markers — beside every observation.
--
-- Relationship to migration 012 (semantic clustering):
--   * 012 established conceptual grouping via embeddings: "these reports
--     are about the same thing".
--   * 013 adds deterministic sub-structure *inside* a semantic cluster:
--     "these reports sound alike but have different root causes". The two
--     are complementary. Embedding clusters stay the primary aggregation
--     surface; the fingerprint provides a durable, regex-derived label
--     (title|err:<code>|frame:<fh>) for read-time sub-clustering and for
--     the SignalLayers UI.
--
-- Invariants preserved:
--   * Evidence (observations / observation_revisions / engagement_snapshots)
--     is untouched — fingerprints are a *derivation*.
--   * Derivation rows are immutable — unique on
--     (observation_id, algorithm_version), insert-only, no UPDATE path.
--   * Sentiment / category / impact / competitor_mention / classification
--     rows are unaffected; replay of older algorithm versions is preserved.
--   * The algorithm_versions.kind check constraint is widened in place so
--     the semantic kinds added in 012 continue to validate.
--   * attach_to_cluster RPC signature (opaque text key) is unchanged.
--   * Cluster-label columns from 012 (label / label_rationale / etc.) are
--     carried through into the rewired mv_observation_current.
--
-- Safe to re-run: table + policy creation is idempotent; the MV block
-- drops-and-recreates (cluster state is in clusters / cluster_members,
-- not in the MV).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) Register the new derivation kind.
-- ----------------------------------------------------------------------------
-- Widen the kind check to include bug_fingerprint without dropping the
-- semantic kinds that 012 added. Drop-and-recreate rather than ALTER so
-- the allowed list stays explicit and auditable.

alter table algorithm_versions drop constraint if exists algorithm_versions_kind_check;
alter table algorithm_versions
  add constraint algorithm_versions_kind_check
  check (kind in (
    'sentiment',
    'category',
    'impact',
    'competitor_mention',
    'classification',
    'observation_embedding',
    'semantic_cluster_label',
    'bug_fingerprint'
  ));

insert into algorithm_versions (kind, version, current_effective, notes) values
  ('bug_fingerprint', 'v1', true,
   'Regex extractor: error codes, top stack frame, env tokens, repro markers, keyword_presence. Compound cluster-key label (title|err|frame) stored per row for audit.')
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

-- ----------------------------------------------------------------------------
-- 2) Derivation table.
-- ----------------------------------------------------------------------------

create table if not exists bug_fingerprints (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  algorithm_version text not null,
  -- Regex-extractor outputs. Each column is the raw determinisitic
  -- signal produced at compute time; nothing in this row depends on
  -- the LLM classifier. See lib/scrapers/bug-fingerprint.ts.
  error_code text,
  top_stack_frame text,
  top_stack_frame_hash text,
  cli_version text,
  os text,
  shell text,
  editor text,
  model_id text,
  repro_markers int not null default 0,
  keyword_presence int not null default 0,
  -- Audit trail: the compound cluster-key label this fingerprint
  -- produced at compute time. Never used as a FK — physical cluster
  -- membership lives in `cluster_members` and is governed by the
  -- semantic pass. The LLM classifier's output is NOT denormalized
  -- here — mv_observation_current joins `classifications` directly so
  -- there is one source of truth per layer (regex vs LLM).
  cluster_key_compound text,
  computed_at timestamptz not null default now(),
  unique (observation_id, algorithm_version)
);

create index if not exists idx_bug_fingerprints_latest
  on bug_fingerprints (observation_id, computed_at desc);
create index if not exists idx_bug_fingerprints_error_code
  on bug_fingerprints (error_code) where error_code is not null;
create index if not exists idx_bug_fingerprints_frame_hash
  on bug_fingerprints (top_stack_frame_hash) where top_stack_frame_hash is not null;

alter table bug_fingerprints enable row level security;
drop policy if exists "public_read_bug_fingerprints" on bug_fingerprints;
create policy "public_read_bug_fingerprints"
  on bug_fingerprints for select to anon, authenticated using (true);
-- No service_role DML policy: writes go through the SECURITY DEFINER RPC
-- below, enforcing append-only at the DB layer.

-- ----------------------------------------------------------------------------
-- 3) Append-only writer RPC.
-- ----------------------------------------------------------------------------

create or replace function record_bug_fingerprint(obs_id uuid, ver text, payload jsonb)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into bug_fingerprints (
    observation_id, algorithm_version,
    error_code, top_stack_frame, top_stack_frame_hash,
    cli_version, os, shell, editor, model_id,
    repro_markers, keyword_presence,
    cluster_key_compound
  ) values (
    obs_id, ver,
    nullif(payload->>'error_code', ''),
    nullif(payload->>'top_stack_frame', ''),
    nullif(payload->>'top_stack_frame_hash', ''),
    nullif(payload->>'cli_version', ''),
    nullif(payload->>'os', ''),
    nullif(payload->>'shell', ''),
    nullif(payload->>'editor', ''),
    nullif(payload->>'model_id', ''),
    coalesce((payload->>'repro_markers')::int, 0),
    coalesce((payload->>'keyword_presence')::int, 0),
    nullif(payload->>'cluster_key_compound', '')
  )
  on conflict (observation_id, algorithm_version) do nothing
  returning id into row_id;
  return row_id;
end;
$$;
grant execute on function record_bug_fingerprint(uuid, text, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- 4) Rewire mv_observation_current to surface the latest fingerprint AND
--    the cluster label columns added in 012.
-- ----------------------------------------------------------------------------
-- mv_trend_daily depends on mv_observation_current, so cascade — and
-- recreate it afterwards so the dashboard's 30-day sparkline survives.

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
-- LLM classification is owned by `classifications`. Join the most
-- recent row per observation directly; no denormalized copy lives in
-- bug_fingerprints, so there is exactly one source of truth per layer.
-- Note: classifications.tags is text[] (Postgres array), accessed with
-- 1-indexed [] subscripting — not jsonb `->>`.
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
  -- Semantic-cluster label columns carried through from migration 012.
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
  -- Fingerprint columns (all nullable — fingerprint rows are produced
  -- lazily during backfill and on every new ingest going forward).
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
  -- LLM classification columns (joined from `classifications`, not
  -- denormalized onto bug_fingerprints). The scraper's post-batch
  -- classification pipeline keeps these fresh.
  lx.llm_subcategory,
  lx.llm_primary_tag,
  lx.llm_category,
  lx.llm_severity,
  lx.llm_confidence,
  lx.llm_model_used,
  lx.llm_classified_at
from observations o
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

-- refresh_materialized_views() signature is unchanged; the next cron
-- run picks up both the new columns and the fingerprint joins.

commit;
