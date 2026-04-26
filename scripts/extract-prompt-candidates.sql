-- ============================================================================
-- Candidate puller for the classifier prompt's few-shot examples.
--
-- Companions:
--   - scripts/extract-prompt-candidates.ts (TS version of the same query)
--   - lib/classification/prompt.ts          (where chosen candidates land)
--   - lib/classification/taxonomy.ts        (CATEGORY_DEFINITIONS to triage against)
--
-- Why this exists
--   The new classifier prompt wants real anchored examples for the
--   most-confused category pairs. The existing classifications.category
--   labels were produced by the OLD prompt (no definitions), so we cannot
--   trust them as ground truth. Instead, we pull RAW report_text by
--   keyword and triage candidates by hand with the new definitions in
--   hand.
--
-- Usage
--   psql "$SUPABASE_DB_URL" -f scripts/extract-prompt-candidates.sql
--   Supabase Studio: paste the whole file into the SQL editor.
--
-- Output
--   One row per candidate. Columns:
--     bucket               which confusable pair surfaced this row
--     pair                 human-readable label of the confusable pair
--     matched_keyword      the keyword that hit
--     observation_id       audit handle (cite back to source)
--     captured_at          when the report was scraped
--     title                report title
--     content_excerpt      first 600 chars of body, whitespace-collapsed
--     url                  source URL
--     legacy_category      hint from the OLD prompt — DO NOT trust as truth
--     legacy_subcategory   same caveat
--     legacy_confidence    same caveat
--     legacy_summary       same caveat
--
--   Up to 10 candidates per bucket × 5 buckets = up to 50 rows.
--
-- Read-only — no writes. Safe to re-run.
-- ============================================================================

with buckets(bucket, pair, keyword) as (values
  -- Bucket 1: context overflow vs retrieval mismatch
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','context window'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','truncated'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','ran out of context'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','attached files'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','wrong file'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','retrieved'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','didn''t read'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','did not read'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','out of tokens'),
  ('context_overflow_vs_retrieval_mismatch','incomplete_context_overflow vs retrieval_context_mismatch','lost track of'),

  -- Bucket 2: tool failure vs env vs plugin
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','command not found'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','ENOENT'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','exit code'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','MCP'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','extension'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','plugin'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','vscode'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','npm err'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','permission denied'),
  ('tool_failure_vs_env_vs_plugin','tool_invocation_error vs dependency_environment_failure vs integration_plugin_failure','timed out'),

  -- Bucket 3: hallucination vs misread intent
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','does not exist'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','doesn''t exist'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','made up'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','invented'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','fabricated'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','no such function'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','wrong function'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','not what i asked'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','ignored my'),
  ('hallucination_vs_misread_intent','hallucinated_code vs user_intent_misinterpretation','misunderstood'),

  -- Bucket 4: code bug vs structural oversight
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','type error'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','typeerror'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','undefined'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','did not update'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','didn''t update'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','interface'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','call site'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','broke the build'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','missing import'),
  ('code_bug_vs_structural_oversight','code_generation_bug vs structural_dependency_oversight','schema mismatch'),

  -- Bucket 5: autonomy / safety
  ('autonomy_safety_violation','autonomy_safety_violation','rm -rf'),
  ('autonomy_safety_violation','autonomy_safety_violation','force push'),
  ('autonomy_safety_violation','autonomy_safety_violation','force-push'),
  ('autonomy_safety_violation','autonomy_safety_violation','leaked'),
  ('autonomy_safety_violation','autonomy_safety_violation','secret'),
  ('autonomy_safety_violation','autonomy_safety_violation','api key'),
  ('autonomy_safety_violation','autonomy_safety_violation','credentials'),
  ('autonomy_safety_violation','autonomy_safety_violation','wiped'),
  ('autonomy_safety_violation','autonomy_safety_violation','dropped table'),
  ('autonomy_safety_violation','autonomy_safety_violation','data loss')
),
matches as (
  -- One row per (bucket, observation) — distinct on collapses multiple
  -- keyword hits inside the same bucket onto the most-recent capture.
  select distinct on (b.bucket, o.id)
    b.bucket, b.pair, b.keyword as matched_keyword,
    o.id as observation_id, o.title, o.content, o.url, o.captured_at
  from buckets b
  join observations o
    on o.title ilike '%' || b.keyword || '%'
    or o.content ilike '%' || b.keyword || '%'
  order by b.bucket, o.id, o.captured_at desc
),
ranked as (
  -- Cap each bucket at the top-10 most recent matches.
  select *,
    row_number() over (
      partition by bucket
      order by captured_at desc nulls last, observation_id
    ) as rk
  from matches
)
select
  r.bucket,
  r.pair,
  r.matched_keyword,
  r.observation_id,
  r.captured_at,
  r.title,
  left(regexp_replace(coalesce(r.content, ''), '\s+', ' ', 'g'), 600) as content_excerpt,
  r.url,
  cls.category as legacy_category,
  cls.subcategory as legacy_subcategory,
  cls.confidence as legacy_confidence,
  cls.summary as legacy_summary
from ranked r
left join lateral (
  select category, subcategory, confidence, summary
  from classifications
  where observation_id = r.observation_id
  order by created_at desc
  limit 1
) cls on true
where r.rk <= 10
order by r.bucket, r.captured_at desc nulls last;
