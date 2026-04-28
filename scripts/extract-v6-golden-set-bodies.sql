-- Pulls production observation bodies for v6 golden-set fixture realism.
-- Match by title fuzzy ILIKE since exact equality may differ in punctuation.
-- Run against admin Supabase; paste output into rows 36-44 of
-- tests/fixtures/topic-golden-set.jsonl.
select
  external_id,
  title,
  substring(body for 600) as body_snippet
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
