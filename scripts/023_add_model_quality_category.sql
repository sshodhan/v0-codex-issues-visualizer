-- 023_add_model_quality_category.sql
--
-- Adds the `model-quality` Topic category and tightens the Pricing
-- phrase list. Companion to the lib/scrapers/shared.ts CATEGORY_PATTERNS
-- update — this migration only seeds the categories table; the matcher
-- changes ship in code.
--
-- Why model-quality exists:
--   The v2 Topic taxonomy had no home for posts about *model behavior*
--   — hallucinations, instruction-following failures, system-prompt
--   distractions, output quality. Such posts were buckeing into Bug
--   (mostly), Other, or — via the noisy `plan` weight-1 hit —
--   accidentally Pricing (e.g. "Make gpt-5.5 not get distracted by
--   excessive Frontend guidance in system prompt"). The new category
--   gives them a first-class slot disjoint from CLI bugs and from the
--   LLM `category` enum (lib/classification/taxonomy.ts), which is a
--   separate, AI-driven classification surfaced as "LLM category" in
--   the UI. See docs/ARCHITECTURE.md §6.0 — Glossary.
--
-- Why Pricing was tightened:
--   v2 Pricing included `plan` at weight 1, wholeWord. Combined with
--   the threshold of 2 it rarely won alone, but bodies that mentioned
--   "plan" twice (or "plan" + a single weight-1 hit) flipped non-pricing
--   posts into Pricing. Replaced with multi-word tier phrases
--   ("free plan", "pro plan", …) that only fire on actual paid-tier
--   discussion.
--
-- Idempotent: ON CONFLICT (slug) DO NOTHING preserves prior runs.
-- Algorithm version bumped to v3 so derivation rows written from this
-- point on are replay-distinct from v2 (per the
-- algorithm_versions / category_assignments invariant in
-- 011_algorithm_v2_bump.sql).

begin;

insert into categories (name, slug, color) values
  ('Model Quality', 'model-quality', '#a855f7')
on conflict (slug) do nothing;

update algorithm_versions
   set current_effective = false
 where kind = 'category'
   and version = 'v2';

insert into algorithm_versions (kind, version, current_effective, notes) values
  ('category', 'v3', true, 'Adds model-quality slot; tightens Pricing (drops bare `plan`, adds multi-word tier phrases)')
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
