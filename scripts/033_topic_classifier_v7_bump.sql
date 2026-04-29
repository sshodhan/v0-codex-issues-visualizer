-- 033_topic_classifier_v7_bump.sql
--
-- Bumps Topic (`category`) algorithm version v6 -> v7. Pricing-only
-- false-positive fix in lib/scrapers/shared.ts. No taxonomy / slug-list
-- changes — the 11-slug Topic taxonomy is unchanged, no new categories,
-- no renames, no removals.
--
-- Why a version bump for what looks like minor edits: the audit drove
-- four changes, two of which alter the scoring contract for every row,
-- not just rows containing the removed phrase. Reusing v6 would mix
-- pre- and post-fix outputs under one label, break replay integrity,
-- and prevent the operator backfill (scripts/033_backfill_topic_v7.ts)
-- from recomputing already-classified rows.
--
-- v7 changes:
--   * pricing: removed `subscription` (weight 3, wholeWord). Audit
--     (Q5: 252 observations matched body `subscription`; only 20 had
--     a co-occurring pricing phrase) showed 92% of body `subscription`
--     matches were GitHub issue-template boilerplate
--     ("### What subscription do you have?  Pro"), not real pricing
--     reports.
--   * BODY_TEMPLATE_HEADER_RE: strips `### <metadata-header>\n<short
--     answer>` from body before phrase scoring. Keyword-whitelisted
--     to subscription/plan/tier/model/version/operating system/os/
--     environment/platform/browser; answer-line capped at 120 chars
--     to protect prose. Catches the dominant false-positive shape
--     (~80% of pricing-tagged rows in the visible-list spot-check on
--     2026-04-29) including `pro plan`, `team plan`, `enterprise
--     plan` leaking from "What plan are you on?" template fields.
--   * Margin-0 abstain rule: when the top winner ties the runner-up
--     (margin 0), categorizeIssue returns "other" with confidence 0
--     instead of falling back to CATEGORY_PATTERNS insertion order
--     (which deterministically favored `pricing` over
--     `model-quality`). The audit found 7 of 45 LLM-validated
--     disagreements (16%) came from this exact pathology.
--   * SLUG_THRESHOLD.pricing = 4 (defense in depth). With
--     `subscription` gone, the remaining single-word pricing phrases
--     at weight 3 could still be sole winners on incidental body
--     mentions. Threshold = 4 means a solo pricing phrase needs at
--     least one weight-4 phrase (e.g., `quota exceeded`, `5-hour
--     limit`, `out of credits`) or two distinct weight ≥ 2 phrases.
--     Real pricing reports clear this comfortably.
--
-- Backfill (REQUIRED per docs/ARCHITECTURE.md §7.4 — the scrape cron
-- only re-classifies on next ingest, so the long tail stays on v6
-- indefinitely without an operator-driven backfill):
--
--   The existing chunked admin route at
--   /api/admin/backfill-derivations rewrites every observation's
--   sentiment/category/impact/competitor_mention rows at the
--   currently-effective algorithm version. Once the v7 row above
--   becomes current_effective and lib/storage/algorithm-versions.ts
--   ships with category: "v7", the route picks it up automatically:
--
--     curl -H "x-admin-secret: $ADMIN_SECRET" \
--          -X POST https://<host>/api/admin/backfill-derivations \
--          -d '{"dryRun": true}'
--     # …iterate cursor until done: true; then re-run with dryRun=false.
--
--   The route's loadAlreadyV2() pre-check (using CURRENT_VERSIONS.category)
--   skips any observation that already has a v7 row, so re-runs are
--   idempotent. The final `done: true` chunk calls
--   refresh_materialized_views(), which refreshes mv_observation_current
--   and mv_cluster_topic_metadata, so no manual MV refresh is required.
--
-- Verification after backfill:
--   select algorithm_version, count(*)
--     from category_assignments
--    group by 1
--    order by 1;
--   -- v7 should be ≥ v6 once the backfill completes.

begin;

update algorithm_versions
   set current_effective = false
 where kind = 'category'
   and version = 'v6';

insert into algorithm_versions (kind, version, current_effective, notes) values
  (
    'category',
    'v7',
    true,
    'Layer 0 Topic classifier v7: pricing-only false-positive fix. Removes `subscription` from pricing patterns (Q5 showed 92% of body matches were template boilerplate), adds BODY_TEMPLATE_HEADER_RE to strip GitHub issue-template metadata fields (`### What plan are you on?\nPro plan` etc.) before phrase scoring, adds margin-0 abstain rule (returns "other" with confidence 0 on ties instead of insertion-order tiebreak that favored `pricing`), and sets SLUG_THRESHOLD.pricing=4 (defense in depth). No taxonomy / slug-list changes. Audit evidence: ~80% false-positive rate on pricing in production (visible-list spot-check 2026-04-29).'
  )
on conflict (kind, version) do update
   set current_effective = excluded.current_effective,
       notes             = excluded.notes;

commit;
