-- 025_topic_classifier_v5_bump.sql
--
-- Bumps Topic (`category`) algorithm version v4 -> v5 after the
-- structural categorizeIssue refactor in lib/scrapers/shared.ts.
--
-- Why: derivation rows in category_assignments are version-stamped.
-- v4 and v5 score the SAME CATEGORY_PATTERNS table differently — title
-- and body are now scored separately and the title contribution is
-- weighted 4×; bracket prefixes ([BUG], [FEATURE], …) are stripped
-- before matching; per-slug thresholds (model-quality 3, pricing 4)
-- replace the global threshold of 2; and the matcher returns
-- structured evidence (matched phrases + per-slug scores + margin +
-- runner-up) persisted into the new category_assignments.evidence
-- JSONB column added by scripts/026_category_assignments_evidence.sql.
--
-- Reusing v4 would mix pre- and post-refactor classifier outputs under
-- one label, break replay integrity, and prevent admin backfill from
-- recomputing already-classified rows.
--
-- Apply order: this migration may be applied before or after 026; the
-- enrich pipeline tolerates a NULL evidence column on existing v5 rows
-- (recordCategory passes null when no evidence is supplied) and the new
-- record_category(uuid, text, uuid, numeric, jsonb) signature added in
-- 026 is what the application calls. If 026 has not yet run, the
-- application's calls will fail with "function … does not exist" — apply
-- 025 + 026 together.

begin;

update algorithm_versions
   set current_effective = false
 where kind = 'category'
   and version = 'v4';

insert into algorithm_versions (kind, version, current_effective, notes) values
  (
    'category',
    'v5',
    true,
    'Structural classifier fixes: title/body scoring split (title 4× weight), [BUG]/[FEATURE] template prefix stripping, per-slug thresholds (model-quality=3, pricing=4), structured evidence emission persisted into category_assignments.evidence (see scripts/026)'
  )
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
