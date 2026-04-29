-- 031_topic_review_events.sql
--
-- Admin Review Loop foundation. Adds the first structured-learning-signal
-- table for Layer 0 (regex_topic) classification governance, plus the two
-- SECURITY DEFINER RPCs the admin storage helper uses to persist review
-- events and (optionally) append a manual topic override into
-- category_assignments.
--
-- Apply order: this migration follows
--   scripts/028_cluster_topic_metadata.sql       (Layer A topic read model, PR #150)
--   scripts/029_family_classifications.sql       (Family Classification v1, PR #157)
--   scripts/030_family_classification_reviews.sql (Family Classification QA, PR #163)
-- The 028, 029, and 030 collisions on this branch were caught when
-- rebasing onto main; the file was renumbered to 031 to land cleanly after
-- all three prerequisites.
--
-- Design notes
-- ------------
--   * topic_review_events is APPEND-ONLY. Reviewers can flag the same
--     observation multiple times under different reason_codes — one row
--     per submission, status starts at 'new'. No update RPC is exposed
--     here; status transitions belong to a future admin workflow. The
--     RLS policies below grant `for all` for service_role only because
--     the SECURITY DEFINER RPC needs INSERT through that role; the
--     application code never issues UPDATE or DELETE against this table.
--
--   * Manual topic overrides land in category_assignments with
--     algorithm_version = 'manual'. The existing v6 row is left intact
--     (append-only invariant from §5.6); mv_observation_current's
--     latest_category CTE picks the most recent computed_at, so the
--     manual override automatically wins on read until a future
--     deterministic pass inserts another row. The override does NOT
--     mutate the original deterministic row — `evidence.overridden_assignment`
--     captures it verbatim so the audit trail is recoverable.
--
--   * The (observation_id, algorithm_version) UNIQUE constraint on
--     category_assignments is replaced with a PARTIAL UNIQUE INDEX that
--     excludes algorithm_version = 'manual'. Deterministic versions
--     remain unique per observation (replay integrity preserved); manual
--     overrides may be appended N times so reviewers can correct an
--     earlier override without mutating the row that recorded it.
--
--   * Reason / suggested-layer / suggested-action / status enums live
--     as CHECK constraints. The same allowlist is mirrored in
--     lib/admin/topic-review.ts so route validation and DB validation
--     can never drift silently — see the contract test in
--     tests/topic-review-contract.test.ts.
--
--   * No CATEGORY_PATTERNS edits, no phrase additions, no LLM tiebreaker,
--     no Layer A / Layer C surface changes. This migration is data
--     plumbing only. Future automation reads topic_review_events to
--     PROPOSE phrase / golden-set / cluster actions — the proposals must
--     still be reviewed by a human before they ship. Specifically,
--     `golden_set_candidate` JSONB is EXPORT-ONLY: the admin UI surfaces
--     it as copyable JSONL but never writes to
--     tests/fixtures/topic-golden-set.jsonl, CATEGORY_PATTERNS, or any
--     repo file. Refer to the non-goals listed in docs/SCORING.md §11.

begin;

-- ----------------------------------------------------------------------------
-- 1) Allow append-only manual overrides into category_assignments.
-- ----------------------------------------------------------------------------
--
-- Original constraint (007_three_layer_split.sql):
--   unique (observation_id, algorithm_version)
-- That makes "manual" usable exactly once per observation. Replace with
-- a partial unique index so deterministic versions still de-dupe but
-- 'manual' may repeat.

alter table category_assignments
  drop constraint if exists category_assignments_observation_id_algorithm_version_key;

create unique index if not exists
  category_assignments_obs_alg_nonmanual_uniq
  on category_assignments (observation_id, algorithm_version)
  where algorithm_version <> 'manual';

create index if not exists idx_category_assignments_manual_obs
  on category_assignments (observation_id, computed_at desc)
  where algorithm_version = 'manual';

-- ----------------------------------------------------------------------------
-- 2) topic_review_events table
-- ----------------------------------------------------------------------------

create table if not exists topic_review_events (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations(id) on delete restrict,
  created_at timestamptz not null default now(),
  reviewer text not null default 'local_admin',

  original_category_id uuid references categories(id) on delete set null,
  original_topic_slug  text,
  corrected_category_id uuid references categories(id) on delete set null,
  corrected_topic_slug  text,

  reason_code text not null check (reason_code in (
    'ambiguous_entity',
    'bad_family_cluster',
    'bad_family_label',
    -- Stage-named "belongs to" reasons; the reviewer is asserting that
    -- the root cause of the misclassification lives in a different
    -- stage of the 5-stage pipeline (PR #162). See lib/admin/topic-review.ts.
    'belongs_to_clustering',
    'belongs_to_llm_classification_family',
    'known_limitation',
    'needs_new_guardrail',
    'other',
    'phrase_false_negative',
    'phrase_false_positive',
    'wrong_regex_topic'
  )),

  -- The column is named `suggested_layer` for historical reasons; the
  -- VALUES are stage-named per the 5-stage classification improvement
  -- pipeline (PR #162). Stage 1 — regex_topic, Stage 2 — embedding,
  -- Stage 3 — clustering, Stage 4 — llm_classification_family,
  -- Stage 5 — human_review_workflow, plus data_quality and unknown.
  suggested_layer text not null check (suggested_layer in (
    'clustering',
    'data_quality',
    'embedding',
    'human_review_workflow',
    'llm_classification_family',
    'regex_topic',
    'unknown'
  )),

  suggested_action text not null check (suggested_action in (
    'add_golden_row',
    'consider_clustering_split_review',
    'consider_llm_taxonomy_update',
    'consider_phrase_addition',
    'consider_phrase_demotion',
    'consider_phrase_removal',
    'known_limitation_no_action',
    'manual_override_only',
    'none'
  )),

  phrase_candidate text,
  rationale text,

  golden_set_candidate jsonb,
  evidence_snapshot jsonb,

  status text not null default 'new' check (status in (
    'accepted', 'candidate', 'exported', 'new', 'rejected', 'resolved'
  ))
);

create index if not exists idx_topic_review_events_observation_id
  on topic_review_events (observation_id, created_at desc);
create index if not exists idx_topic_review_events_reason_code
  on topic_review_events (reason_code, created_at desc);
create index if not exists idx_topic_review_events_suggested_layer
  on topic_review_events (suggested_layer, created_at desc);
create index if not exists idx_topic_review_events_suggested_action
  on topic_review_events (suggested_action, created_at desc);
create index if not exists idx_topic_review_events_status
  on topic_review_events (status, created_at desc);
create index if not exists idx_topic_review_events_created_at
  on topic_review_events (created_at desc);

alter table topic_review_events enable row level security;

drop policy if exists "service_all_topic_review_events" on topic_review_events;
create policy "service_all_topic_review_events" on topic_review_events
  for all to service_role using (true) with check (true);

drop policy if exists "public_read_topic_review_events" on topic_review_events;
create policy "public_read_topic_review_events" on topic_review_events
  for select using (true);

-- ----------------------------------------------------------------------------
-- 3) RPC: append a topic_review_events row
-- ----------------------------------------------------------------------------

drop function if exists record_topic_review_event(jsonb) cascade;

create or replace function record_topic_review_event(payload jsonb)
returns uuid
language plpgsql
security definer
as $$
declare
  row_id uuid;
begin
  insert into topic_review_events (
    observation_id,
    reviewer,
    original_category_id,
    original_topic_slug,
    corrected_category_id,
    corrected_topic_slug,
    reason_code,
    suggested_layer,
    suggested_action,
    phrase_candidate,
    rationale,
    golden_set_candidate,
    evidence_snapshot,
    status
  )
  values (
    (payload ->> 'observation_id')::uuid,
    coalesce(payload ->> 'reviewer', 'local_admin'),
    nullif(payload ->> 'original_category_id', '')::uuid,
    nullif(payload ->> 'original_topic_slug', ''),
    nullif(payload ->> 'corrected_category_id', '')::uuid,
    nullif(payload ->> 'corrected_topic_slug', ''),
    payload ->> 'reason_code',
    payload ->> 'suggested_layer',
    payload ->> 'suggested_action',
    nullif(payload ->> 'phrase_candidate', ''),
    nullif(payload ->> 'rationale', ''),
    payload -> 'golden_set_candidate',
    payload -> 'evidence_snapshot',
    coalesce(payload ->> 'status', 'new')
  )
  returning id into row_id;
  return row_id;
end;
$$;

grant execute on function record_topic_review_event(jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- 4) RPC: append a manual topic override into category_assignments
-- ----------------------------------------------------------------------------
--
-- Bypasses the standard record_category() conflict-do-nothing flow because
-- manual overrides are intentionally append-only (see partial unique index
-- above). evidence carries the override metadata documented in
-- docs/SCORING.md and is required so a future audit can always recover
-- both the original deterministic result and the corrected slug.

drop function if exists record_manual_topic_override(uuid, uuid, jsonb) cascade;

create or replace function record_manual_topic_override(
  obs_id uuid,
  cat_id uuid,
  ev    jsonb
)
returns uuid
language plpgsql
security definer
as $$
declare
  row_id uuid;
begin
  insert into category_assignments (
    observation_id, algorithm_version, category_id, confidence, evidence
  )
  values (obs_id, 'manual', cat_id, 1.0, ev)
  returning id into row_id;
  return row_id;
end;
$$;

grant execute on function record_manual_topic_override(uuid, uuid, jsonb) to service_role;

commit;
