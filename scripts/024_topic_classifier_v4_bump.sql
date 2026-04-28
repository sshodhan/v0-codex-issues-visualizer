-- 024_topic_classifier_v4_bump.sql
--
-- Bumps Topic (`category`) algorithm version v3 -> v4 after the
-- CATEGORY_PATTERNS expansion/reweight in lib/scrapers/shared.ts.
--
-- Why: derivation rows in category_assignments are version-stamped.
-- Reusing v3 would mix pre- and post-change classifier outputs under
-- one label, break replay integrity, and prevent admin backfill from
-- recomputing already-classified rows.

begin;

update algorithm_versions
   set current_effective = false
 where kind = 'category'
   and version = 'v3';

insert into algorithm_versions (kind, version, current_effective, notes) values
  (
    'category',
    'v4',
    true,
    'Expands Topic regex phrases/reweights for MCP/tool invocation/file-edit integration failures, quota-vs-api disambiguation, model looping/context-loss, and UX diff/approval/loading signals'
  )
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
