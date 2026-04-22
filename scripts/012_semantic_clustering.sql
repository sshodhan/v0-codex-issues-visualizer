-- Semantic clustering extensions.
-- Adds an embedding derivation layer and optional human-readable labeling
-- metadata for clusters.

begin;

create table if not exists observation_embeddings (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  algorithm_version text not null,
  model text not null,
  dimensions integer not null,
  input_text text not null,
  vector jsonb not null,
  computed_at timestamptz not null default now(),
  unique (observation_id, algorithm_version)
);
create index if not exists idx_observation_embeddings_obs
  on observation_embeddings (observation_id, computed_at desc);

-- The algorithm_versions.kind check constraint from scripts/007 only allows
-- the original derivation kinds. Widen it so the two new semantic kinds below
-- can be inserted.
alter table algorithm_versions
  drop constraint if exists algorithm_versions_kind_check;
alter table algorithm_versions
  add constraint algorithm_versions_kind_check
  check (kind in (
    'sentiment',
    'category',
    'impact',
    'competitor_mention',
    'classification',
    'observation_embedding',
    'semantic_cluster_label'
  ));

insert into algorithm_versions(kind, version, current_effective, notes)
values
  ('observation_embedding', 'v1', true, 'OpenAI embeddings for semantic clustering'),
  ('semantic_cluster_label', 'v1', true, 'LLM-generated human-readable semantic cluster labels')
on conflict do nothing;

alter table clusters add column if not exists label text;
alter table clusters add column if not exists label_rationale text;
alter table clusters add column if not exists label_confidence numeric(3,2);
alter table clusters add column if not exists label_model text;
alter table clusters add column if not exists label_algorithm_version text;
alter table clusters add column if not exists labeling_updated_at timestamptz;

create or replace function record_observation_embedding(
  obs_id uuid,
  ver text,
  model_name text,
  dims integer,
  input_text text,
  vec jsonb
)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into observation_embeddings (
    observation_id, algorithm_version, model, dimensions, input_text, vector
  )
  values (obs_id, ver, model_name, dims, input_text, vec)
  on conflict (observation_id, algorithm_version) do update
    set model = excluded.model,
        dimensions = excluded.dimensions,
        input_text = excluded.input_text,
        vector = excluded.vector,
        computed_at = now()
  returning id into row_id;

  return row_id;
end;
$$;
grant execute on function record_observation_embedding(uuid, text, text, integer, text, jsonb) to service_role;

create or replace function set_cluster_label(
  cluster_uuid uuid,
  lbl text,
  lbl_rationale text,
  lbl_confidence numeric,
  lbl_model text,
  lbl_alg_ver text
)
returns void
language plpgsql
security definer
as $$
begin
  update clusters
     set label = lbl,
         label_rationale = lbl_rationale,
         label_confidence = lbl_confidence,
         label_model = lbl_model,
         label_algorithm_version = lbl_alg_ver,
         labeling_updated_at = now()
   where id = cluster_uuid;
end;
$$;
grant execute on function set_cluster_label(uuid, text, text, numeric, text, text) to service_role;

alter table observation_embeddings enable row level security;

create policy "public_read_observation_embeddings"
  on observation_embeddings for select to anon, authenticated using (true);

create policy "service_rw_observation_embeddings"
  on observation_embeddings for all to service_role using (true) with check (true);

commit;
