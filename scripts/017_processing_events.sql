-- 017_processing_events.sql
-- Immutable stage-transition log for per-observation processing traceability.
-- (Renumbered from 016 — 016_cluster_health_read_model.sql already held that slot.)

create table if not exists processing_events (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete cascade,
  stage text not null check (stage in ('fingerprinting', 'embedding', 'clustering', 'classification', 'review')),
  status text not null,
  algorithm_version_model text,
  detail_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_processing_events_observation_created
  on processing_events(observation_id, created_at asc);

create index if not exists idx_processing_events_stage_created
  on processing_events(stage, created_at desc);
