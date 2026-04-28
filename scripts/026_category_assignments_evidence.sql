-- 026_category_assignments_evidence.sql
--
-- Adds a JSONB `evidence` column to category_assignments and extends
-- the record_category() RPC to persist it. Companion to the v5 Topic
-- classifier refactor (see scripts/025_topic_classifier_v5_bump.sql).
--
-- Shape of evidence (written by lib/scrapers/shared.ts → categorizeIssue):
--   {
--     "matched_phrases": [
--       { "phrase": "hallucinate", "weight": 16, "in": "title" },
--       { "phrase": "wrong answer", "weight": 1,  "in": "body"  }
--     ],
--     "scores":    { "model-quality": 17, "bug": 4 },
--     "margin":    13,
--     "runner_up": "bug",
--     "threshold": 3
--   }
--
-- "weight" stores the EFFECTIVE weight applied (i.e. pattern weight ×
-- segment multiplier), so a title hit of weight 4 is recorded as 16
-- under the v5 4× title multiplier. This matches the per-slug "scores"
-- aggregate so admins reading a single row see a self-consistent
-- accounting.
--
-- Why JSONB and not separate columns:
--   - The matched_phrases array is variable-length per row and per
--     observation (different posts hit different phrases).
--   - We want SQL-queryable structure for admin debugging
--     (jsonb_array_elements, ->>) without committing to a relational
--     phrase-hit child table that would 10–50× row volume.
--
-- The column is nullable. v4 and earlier rows stay at NULL; v5 rows
-- written via the new RPC carry the JSONB. Read paths that don't care
-- about evidence ignore the column.
--
-- Apply order: see header note in 025; apply 025 + 026 together.

begin;

alter table category_assignments
  add column if not exists evidence jsonb;

-- Create the new 5-arg form that persists evidence. The old 4-arg form is
-- kept as a compatibility wrapper (see below) so any old code path that
-- runs before app code is deployed does not 500.
create or replace function record_category(
  obs_id uuid,
  ver    text,
  cat_id uuid,
  conf   numeric,
  ev     jsonb
)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into category_assignments (
    observation_id, algorithm_version, category_id, confidence, evidence
  )
  values (obs_id, ver, cat_id, conf, ev)
  on conflict (observation_id, algorithm_version) do nothing
  returning id into row_id;
  return row_id;
end;
$$;

grant execute on function record_category(uuid, text, uuid, numeric, jsonb) to service_role;

-- Backward-compatible 4-arg wrapper. Delegates to the 5-arg form with
-- ev = null. Prevents deployment-order failures: old app code that calls
-- the 4-arg form continues to work after this migration, and new app
-- code that calls the 5-arg form works both before and after.
create or replace function record_category(
  obs_id uuid,
  ver    text,
  cat_id uuid,
  conf   numeric
)
returns uuid
language plpgsql
security definer
as $$
begin
  return record_category(obs_id, ver, cat_id, conf, null::jsonb);
end;
$$;

grant execute on function record_category(uuid, text, uuid, numeric) to service_role;

commit;
