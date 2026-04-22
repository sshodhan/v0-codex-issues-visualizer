-- 011_algorithm_v2_bump.sql
--
-- Registers v2 of the impact / sentiment / category / competitor_mention
-- derivation algorithms in the `algorithm_versions` registry and flips v1
-- off as current_effective.
--
-- Why v2 exists:
--   - impact v2 adds source-authority weighting (first-party GitHub issues
--     outrank announcement/news channels at identical engagement) and
--     persists source_slug in inputs_jsonb so the score stays recomputable
--     from captured evidence alone (ARCHITECTURE.md §3.1b).
--   - sentiment v2 expands the negative-polarity lexicon with complaint
--     markers that v1 missed ("unable", "stuck", "missing", "can't",
--     "cannot", …) plus multi-word patterns ("does not work",
--     "keeps <V-ing>"). Topic/status words ("broken", "fails", "failed")
--     stay OUT of the polarity lexicon to preserve the P0-2 separation
--     between polarity and `keyword_presence`.
--   - category v2 expands phrase lists (Bug `issue`/`unable to`/`fails`;
--     Documentation `review`/`hands-on`/`walkthrough`; Integration
--     `github auth`/`open-source llms`; Feature Request `support for`).
--     Threshold stays at 2 — stronger phrase weights carry the eye-test
--     rows without lowering the floor.
--   - competitor_mention v2 is a lockstep bump: the scoreMentionSentiment
--     code path in lib/analytics/competitive.ts reads the canonical
--     lexicon, and the sentiment v2 additions intersect NEGATORS at
--     "cannot"/"can't" — same input now scores differently, so mention
--     rows written going forward are no longer apples-to-apples with v1.
--     Bumping preserves replay integrity.
--
-- Invariants preserved:
--   - Derivation tables (sentiment_scores, category_assignments,
--     impact_scores) are NOT updated. The next enrich pass writes fresh v2
--     rows alongside the existing v1 rows for replay comparison
--     (docs/ARCHITECTURE.md v10 §7.4).
--   - `idx_algorithm_versions_one_current` is a partial unique index on
--     `algorithm_versions(kind) WHERE current_effective`. We flip v1 to
--     false BEFORE inserting v2 with true, inside a single transaction,
--     so the constraint never sees two effective rows per kind.
--   - Idempotent (re-run-safe) via the UPDATE and the upsert's
--     ON CONFLICT clause.

begin;

update algorithm_versions
   set current_effective = false
 where kind in ('impact', 'sentiment', 'category', 'competitor_mention')
   and version = 'v1';

insert into algorithm_versions (kind, version, current_effective, notes) values
  ('impact',             'v2', true, 'Source-authority weighting; source_slug in inputs_jsonb (eye-test Pattern A)'),
  ('sentiment',          'v2', true, 'Complaint-marker lexicon + curly-apostrophe normalization + multi-word patterns (eye-test Pattern B)'),
  ('category',           'v2', true, 'Broader phrase lists; threshold=2 preserved (eye-test Pattern C)'),
  ('competitor_mention', 'v2', true, 'Lockstep bump — shares lexicon with sentiment v2; NEGATORS intersect at can''t/cannot')
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
