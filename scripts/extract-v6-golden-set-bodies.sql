-- Pulls production observation bodies for v6 golden-set fixture realism.
-- Match by title fuzzy ILIKE since exact equality may differ in punctuation.
-- Run against admin Supabase; paste output into the empty-body rows in
-- tests/fixtures/topic-golden-set.jsonl (rows 36-43 — the v6 guardrail
-- rows that ship with `"body":""`; rows 44+ are intentionally empty-body
-- and are not matched by the ILIKE patterns below).
--
-- The observations table column is `content` (see scripts/007 §evidence
-- layer); historical drafts of this helper used `body`, which would
-- error against the live schema.
select
  external_id,
  title,
  substring(content for 600) as body_snippet
from observations
where title ilike '%merge pull request%branch has conflicts%'
   or title ilike '%stopped showing my progress logs%'
   or title ilike '%mini model, higher limits%'
   or title ilike '%developerInstructions%'
   or title ilike '%full access session still launches in workspace-write%'
   or title ilike '%ansi escape code injection%'
   or title ilike '%additionalContext in PreToolUse%'
   or title ilike '%a project with openai codex cli%'
order by title;
