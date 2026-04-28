-- 025_topic_classifier_v5_bump.sql
--
-- Bumps Topic (`category`) algorithm version v4 -> v5 after the
-- structural categorizeIssue refactor in lib/scrapers/shared.ts.
--
-- Why: derivation rows in category_assignments are version-stamped.
-- v4 and v5 score the SAME CATEGORY_PATTERNS table differently — title
-- and body are now scored separately and the title contribution is
-- weighted 4×; bracket prefixes ([BUG], [FEATURE], …) are stripped
-- before matching with the stripped prefix preserved in evidence; the
-- per-slug threshold mechanism (SLUG_THRESHOLD) is wired up but ships
-- empty in v5 — global threshold of 2 still applies to all slugs;
-- threshold tuning is deferred until backfill evidence shows need.
-- The matcher returns structured TopicResult { categoryId, slug,
-- confidenceProxy, evidence } where evidence is a self-describing
-- JSONB persisted into the new category_assignments.evidence column
-- added by scripts/026_category_assignments_evidence.sql.
--
-- Reusing v4 would mix pre- and post-refactor classifier outputs under
-- one label, break replay integrity, and prevent admin backfill from
-- recomputing already-classified rows.
--
-- Apply order: 025 + 026 must be applied together. The enrich pipeline
-- calls the new 5-arg record_category(uuid, text, uuid, numeric, jsonb)
-- signature added in 026, so 026 must run before any v5 derivation
-- write — and 025 is what flips the registry to v5 in the first place.

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
    'Structural classifier fixes: title/body scoring split (title 4× weight), [BUG]/[FEATURE] template prefix stripping (prefix preserved in evidence), per-slug threshold mechanism (SLUG_THRESHOLD) wired but empty (default 2 applies; tuning deferred), structured evidence emission persisted into category_assignments.evidence (see scripts/026)'
  )
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
