-- ============================================================================
-- Migration 020: add `subcategory` column to classification_reviews so
-- reviewers can override the LLM mechanism slug independently of category.
--
-- Why this exists
--   The append-only `classification_reviews` table previously stored
--   reviewer overrides for status, category, severity, and
--   needs_human_review — but NOT subcategory. After PR #105 introduced
--   the v2 LLM taxonomy with stable per-category subcategory vocabularies
--   (lib/classification/taxonomy.ts SUBCATEGORY_EXAMPLES), reviewers
--   need to be able to relabel the mechanism even when the category is
--   already correct. Without this column an "AI says
--   code_generation_bug.logic_bug, reviewer says
--   code_generation_bug.api_misuse" correction was unrepresentable.
--
-- Append-only contract preserved
--   This migration only ADDs a nullable column and recreates the
--   `record_classification_review` RPC to forward the new field. No
--   existing rows are modified. Historical reviews keep
--   subcategory = NULL, which the read path treats as "reviewer did not
--   override; fall back to baseline classifications.subcategory".
-- ============================================================================

begin;

alter table classification_reviews
  add column if not exists subcategory text;

create or replace function record_classification_review(cls_id uuid, payload jsonb)
returns uuid
language plpgsql
security definer
as $$
declare row_id uuid;
begin
  insert into classification_reviews (
    classification_id, status, category, subcategory, severity, needs_human_review,
    reviewer_notes, reviewed_by
  ) values (
    cls_id,
    payload->>'status',
    payload->>'category',
    payload->>'subcategory',
    payload->>'severity',
    nullif(payload->>'needs_human_review','')::boolean,
    payload->>'reviewer_notes',
    payload->>'reviewed_by'
  ) returning id into row_id;
  return row_id;
end;
$$;

grant execute on function record_classification_review(uuid, jsonb) to service_role;

commit;
