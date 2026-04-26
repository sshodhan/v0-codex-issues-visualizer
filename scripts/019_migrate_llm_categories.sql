-- ============================================================================
-- Migration 019: backfill legacy LLM category slugs to the v2 taxonomy.
--
-- Companions:
--   - lib/classification/taxonomy.ts        — CATEGORY_ENUM (v2)
--   - lib/classification/prompt.ts          — TAXONOMY block shown to model
--   - lib/classification/pipeline.ts        — autonomy_safety_violation rule
--   - lib/classification/llm-category-display.ts — labels + palette
--   - scripts/019_migrate_llm_categories.ts — read-only dry-run preview
--
-- Why this is SQL, not TypeScript
--   `008_revoke_service_role_dml.sql` REVOKEs INSERT/UPDATE/DELETE on
--   `classifications` and `classification_reviews` from `service_role`. Any
--   `.update()` from `lib/supabase/admin.ts` (service_role JWT) is denied
--   at the privilege layer. This file must be applied as the postgres /
--   migration role:
--
--     psql "$SUPABASE_DB_URL" -f scripts/019_migrate_llm_categories.sql
--
-- What this migration does
--   1. Snapshots affected `classifications` and `classification_reviews`
--      rows into dated backup tables so the change is reversible.
--   2. Rewrites `classifications.category` from each legacy slug to its
--      v2 counterpart. Idempotent: the WHERE clause filters to legacy
--      slugs only, so re-runs are no-ops.
--   3. Rewrites `classifications.alternate_categories[]` element-wise
--      with the same mapping; non-legacy elements are passed through.
--   4. Rewrites `classifications.review_reasons[]` to replace the
--      `safety_policy_category` reason key with the new
--      `autonomy_safety_violation_category` key.
--   5. APPENDS a synthetic `classification_reviews` row for any review
--      whose category is a legacy slug, attributing the remap to
--      `migration:llm-taxonomy-v2`. The original reviewer row is left
--      in place so the audit chain is preserved; the appended row
--      becomes the latest by `reviewed_at desc`, so effective_category
--      resolves to the v2 value.
--   6. Refreshes `mv_observation_current` and downstream MVs.
--
-- What this migration deliberately does NOT do
--   - It does NOT mutate `classifications.raw_json`. raw_json is the
--     model's original output — preserved verbatim as the lineage
--     trace. The v2 slug lives only in the column.
--   - It does NOT bump `algorithm_versions.classification`. The
--     classifier prompt/schema/model envelope is unchanged in shape;
--     this is a vocabulary rename. `app/api/classifications/route.ts`
--     does not yet filter by `current_effective`, so an INSERT-based
--     v2 bump would double-count rows in the triage queue. If the
--     team wants a real v2 bump later, do it in a separate migration
--     that also updates the read paths.
--
-- Replay caveat
--   `?as_of=T` queries against `classifications.category` for
--   timestamps before this migration ran will, after this migration,
--   reflect the v2 vocabulary instead of the v1 vocabulary. This is
--   the intentional trade-off for keeping dashboards consistent
--   without doubling row volume; the v1 vocabulary is preserved in
--   `raw_json` for forensic recovery and in the dated backup tables
--   for direct rollback.
--
-- Deploy order (follow strictly)
--   1. Deploy code that knows the v2 enum (this PR).
--   2. Verify post-deploy classifications use v2 slugs.
--   3. Run the dry-run preview:
--        node --experimental-strip-types scripts/019_migrate_llm_categories.ts
--   4. In a maintenance window, apply this SQL.
--   5. Re-run the preview and confirm `legacy_remaining = 0`.
-- ============================================================================

begin;

do $migration_019$
declare
  ts text := to_char(timezone('UTC', now()), 'YYYYMMDD');
  classifications_backup text := 'classifications_pre019_' || ts;
  reviews_backup text := 'classification_reviews_pre019_' || ts;
  legacy_slugs constant text[] := array[
    'code-generation-quality','hallucination','tool-use-failure',
    'context-handling','latency-performance','auth-session','cli-ux',
    'install-env','cost-quota','safety-policy','integration-mcp','other'
  ];
  baseline_updated bigint;
  alternates_updated bigint;
  reasons_updated bigint;
  reviews_appended bigint;
  baseline_legacy_remaining bigint;
  alternate_legacy_remaining bigint;
  latest_review_legacy_remaining bigint;
begin
  -- 1) Snapshot affected rows for safe rollback. Dated backup table
  -- names; re-runs on the same UTC day are no-ops via IF NOT EXISTS.

  execute format(
    'create table if not exists %I as
       select id, category, alternate_categories, review_reasons
       from classifications
       where category = any($1)
         or alternate_categories && $1
         or ''safety_policy_category'' = any(review_reasons)',
    classifications_backup
  ) using legacy_slugs;

  execute format(
    'create table if not exists %I as
       select id, classification_id, category, reviewed_at
       from classification_reviews
       where category = any($1)',
    reviews_backup
  ) using legacy_slugs;

  raise notice 'migration 019: snapshot tables ready (%, %)',
    classifications_backup, reviews_backup;

  -- 2) Remap classifications.category. Idempotent: rows already at a
  -- v2 slug do not match the WHERE clause.

  update classifications
  set category = case category
    when 'code-generation-quality' then 'code_generation_bug'
    when 'hallucination'           then 'hallucinated_code'
    when 'tool-use-failure'        then 'tool_invocation_error'
    when 'context-handling'        then 'incomplete_context_overflow'
    when 'latency-performance'     then 'performance_latency_issue'
    when 'auth-session'            then 'session_auth_error'
    when 'cli-ux'                  then 'cli_user_experience_bug'
    when 'install-env'             then 'dependency_environment_failure'
    when 'cost-quota'              then 'cost_quota_overrun'
    when 'safety-policy'           then 'autonomy_safety_violation'
    when 'integration-mcp'         then 'integration_plugin_failure'
    when 'other'                   then 'user_intent_misinterpretation'
  end
  where category = any(legacy_slugs);
  get diagnostics baseline_updated = row_count;

  -- 3) Remap alternate_categories array elements. Rewrites the entire
  -- array even if only one element is legacy; non-legacy elements
  -- pass through unchanged.

  update classifications c
  set alternate_categories = (
    select array(
      select case alt
        when 'code-generation-quality' then 'code_generation_bug'
        when 'hallucination'           then 'hallucinated_code'
        when 'tool-use-failure'        then 'tool_invocation_error'
        when 'context-handling'        then 'incomplete_context_overflow'
        when 'latency-performance'     then 'performance_latency_issue'
        when 'auth-session'            then 'session_auth_error'
        when 'cli-ux'                  then 'cli_user_experience_bug'
        when 'install-env'             then 'dependency_environment_failure'
        when 'cost-quota'              then 'cost_quota_overrun'
        when 'safety-policy'           then 'autonomy_safety_violation'
        when 'integration-mcp'         then 'integration_plugin_failure'
        when 'other'                   then 'user_intent_misinterpretation'
        else alt
      end
      from unnest(c.alternate_categories) as alt
    )
  )
  where c.alternate_categories && legacy_slugs;
  get diagnostics alternates_updated = row_count;

  -- 4) Rewrite the renamed review-reason key. Other keys are unaffected.

  update classifications
  set review_reasons = array_replace(
    review_reasons,
    'safety_policy_category',
    'autonomy_safety_violation_category'
  )
  where 'safety_policy_category' = any(review_reasons);
  get diagnostics reasons_updated = row_count;

  -- 5) Append synthetic review rows for legacy reviewer overrides. We do
  -- NOT update the historical row; the appended row becomes the latest
  -- by reviewed_at desc, so effective_category resolves to v2.
  -- Idempotent: skipped if a remap row already exists at or after the
  -- legacy row's reviewed_at for the same classification_id.

  insert into classification_reviews (
    classification_id, status, category, severity, needs_human_review,
    reviewer_notes, reviewed_by
  )
  select
    cr.classification_id,
    cr.status,
    case cr.category
      when 'code-generation-quality' then 'code_generation_bug'
      when 'hallucination'           then 'hallucinated_code'
      when 'tool-use-failure'        then 'tool_invocation_error'
      when 'context-handling'        then 'incomplete_context_overflow'
      when 'latency-performance'     then 'performance_latency_issue'
      when 'auth-session'            then 'session_auth_error'
      when 'cli-ux'                  then 'cli_user_experience_bug'
      when 'install-env'             then 'dependency_environment_failure'
      when 'cost-quota'              then 'cost_quota_overrun'
      when 'safety-policy'           then 'autonomy_safety_violation'
      when 'integration-mcp'         then 'integration_plugin_failure'
      when 'other'                   then 'user_intent_misinterpretation'
    end,
    cr.severity,
    cr.needs_human_review,
    format(
      'System remap of legacy reviewer category "%s" to v2 taxonomy. Original review id=%s; see scripts/019_migrate_llm_categories.sql.',
      cr.category, cr.id
    ),
    'migration:llm-taxonomy-v2'
  from classification_reviews cr
  where cr.category = any(legacy_slugs)
    and not exists (
      select 1
      from classification_reviews remap
      where remap.classification_id = cr.classification_id
        and remap.reviewed_by = 'migration:llm-taxonomy-v2'
        and remap.reviewed_at >= cr.reviewed_at
    );
  get diagnostics reviews_appended = row_count;

  -- 6) Sanity check. RAISE EXCEPTION rolls back the transaction if any
  -- legacy slug remains on baseline, on alternates, or as the latest
  -- reviewer override per classification.

  select count(*) into baseline_legacy_remaining
    from classifications where category = any(legacy_slugs);

  select count(*) into alternate_legacy_remaining
    from classifications where alternate_categories && legacy_slugs;

  select count(*) into latest_review_legacy_remaining
    from (
      select distinct on (classification_id) category
      from classification_reviews
      order by classification_id, reviewed_at desc
    ) latest_reviews
    where category = any(legacy_slugs);

  if baseline_legacy_remaining > 0
     or alternate_legacy_remaining > 0
     or latest_review_legacy_remaining > 0 then
    raise exception
      'migration 019 sanity check failed: baseline=%, alternates=%, latest_review=%',
      baseline_legacy_remaining, alternate_legacy_remaining,
      latest_review_legacy_remaining;
  end if;

  raise notice 'migration 019 summary: baseline_updated=%, alternates_updated=%, reasons_updated=%, reviews_appended=%',
    baseline_updated, alternates_updated, reasons_updated, reviews_appended;
end
$migration_019$;

commit;

-- 7) Refresh dependent materialized views. Outside the transaction so
-- `refresh materialized view concurrently` is allowed (it cannot run
-- inside a transaction block). `refresh_materialized_views()` is the
-- SECURITY DEFINER helper defined in 016_cluster_health_read_model.sql.

select refresh_materialized_views();

-- ROLLBACK (manual; replace YYYYMMDD with the actual backup date):
--
--   begin;
--     update classifications c
--       set category = b.category,
--           alternate_categories = b.alternate_categories,
--           review_reasons = b.review_reasons
--       from classifications_pre019_YYYYMMDD b
--       where c.id = b.id;
--
--     delete from classification_reviews
--       where reviewed_by = 'migration:llm-taxonomy-v2';
--   commit;
--   select refresh_materialized_views();
--
-- CLEANUP (after verification, when rollback is no longer needed):
--   drop table if exists classifications_pre019_YYYYMMDD;
--   drop table if exists classification_reviews_pre019_YYYYMMDD;
