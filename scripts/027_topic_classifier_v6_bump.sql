-- 027_topic_classifier_v6_bump.sql
--
-- Bumps Topic (`category`) algorithm version v5 -> v6 after the
-- phrase-table maintenance pass on CATEGORY_PATTERNS in
-- lib/scrapers/shared.ts. No scoring architecture changes — title/body
-- split, 4× title weight, template-prefix stripping, structured
-- evidence emission, and the (still-empty) SLUG_THRESHOLD mechanism
-- carry over from v5 unchanged.
--
-- v6 phrase-table edits (driven by the v5 low-margin / manual review):
--   * model-quality: developerInstructions / additionalContext-ignored
--     vocabulary.
--   * bug: merge/branch-conflict, model-does-not-appear (bounded),
--     workspace-write / bubblewrap sandbox, device passthrough.
--   * ux-ui: progress-logs visibility.
--   * integration: additionalContext / PreToolUse hook-context phrases.
--   * pricing: higher-limits, priority-processing.
--   * security: ANSI escape-code injection (bounded phrases only — no
--     bare "code injection" or bare "ansi escape").
--   * feature-request: support/add additionalContext, pretooluse-hooks,
--     bypass-the-approval-prompt at w5 (intentionally outscores ux-ui
--     "approval prompt" w4 — see the row-46 no-tie test in
--     tests/topic-classifier-golden-set.test.ts), wish-style phrases.
--   * additionalContext / PreToolUse intent distinctions (the v6
--     anti-whack-a-mole guardrail): "additionalContext" is an entity,
--     not an intent — Topic comes from the surrounding mechanism.
--     Bounded phrases route the four intents to four slugs:
--       - support/add additionalContext         → feature-request
--       - ignored/not used additionalContext    → model-quality
--       - not passed/missing in hook payload    → integration
--       - crashes with additionalContext        → bug (existing
--         crash/crashes phrases carry it; no new bug phrase needed)
--     The fixture carries one contrast row per slug so a future bare
--     "additionalcontext" phrase cannot collapse all four into one.
--   * documentation: removes weak "how to" w1 (a question prefix is
--     not docs-complaint language).
--
-- Reusing v5 would mix pre- and post-phrase-edit classifier outputs
-- under one label, break replay integrity, and prevent admin backfill
-- from recomputing already-classified rows.

begin;

update algorithm_versions
   set current_effective = false
 where kind = 'category'
   and version = 'v5';

insert into algorithm_versions (kind, version, current_effective, notes) values
  (
    'category',
    'v6',
    true,
    'Layer 0 Topic classifier v6: targeted phrase maintenance after v5 evidence review. Adds bounded coding-agent phrases for developerInstructions, merge conflicts, progress-log visibility, limits/priority processing, missing model, sandbox/passthrough, ANSI escape injection, and additionalContext/PreToolUse intent distinctions (support/add → feature-request, ignored/not used → model-quality, missing/not passed → integration, crashes → bug); removes weak documentation "how to" match. No scoring architecture changes; threshold overrides remain empty.'
  )
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
