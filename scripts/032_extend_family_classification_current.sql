-- 032_extend_family_classification_current.sql
--
-- Extend the `family_classification_current` view (defined in 029) to
-- expose the per-classification topic-metadata snapshot and LLM
-- provenance fields that the admin Family Quality Dashboard already
-- expects to read.
--
-- Why this exists:
--   The dashboard route at `app/api/admin/family-classification/quality`
--   was authored against an imagined view shape that included
--   `observation_count`, `classification_coverage_share`,
--   `mixed_topic_score`, `cluster_path`, plus `llm_status` / `llm_model`
--   / `llm_classified_at` / `classified_at` / `updated_at`. The
--   underlying 029 view never exposed any of those columns, so the
--   route 500s with `column family_classification_current.observation_count
--   does not exist`. PR #160 (which added the dashboard) shipped the
--   consumer against a shape nobody had migrated; PRs #162 and #163
--   stacked copy and a review loop on top without noticing. This
--   migration is the missing producer-side change.
--
-- Source of the joined columns:
--   `lib/storage/family-classification.ts` snapshots the cluster's
--   topic-metadata into `evidence.cluster_topic_metadata` and the LLM
--   provenance into `evidence.llm` when the classification row is
--   written (see lines 910-927). Lifting from the snapshot — rather
--   than joining `mv_cluster_topic_metadata` — is deliberate:
--     * a quality dashboard is asking "given what the classifier saw,
--       did it produce a coherent verdict?". The right anchor is the
--       point-in-time snapshot, not whatever the live MV looks like
--       seconds later.
--     * the MV is refreshed by cron (see scripts/028); a freshly
--       classified family would otherwise show NULL coverage/mixedness
--       until the next refresh tick.
--     * matches the audit contract in CLUSTERING_DESIGN §4.7: the
--       evidence JSONB is the authoritative record of what the
--       classifier knew at write time.
--
-- Timestamp aliases:
--   `family_classifications` is append-only, so `computed_at` is the
--   single natural value for both `classified_at` and `updated_at`.
--   `llm_classified_at` is set to `computed_at` when the LLM actually
--   ran (`status` is not one of the `skipped_*` values), null
--   otherwise — matches the producer's contract that the LLM call
--   happens inline with classification when it runs at all.
--
-- Apply order: 029 → 030 (review table, doesn't depend on this view)
-- → 032 (this).

begin;

-- DROP + CREATE rather than CREATE OR REPLACE: we are adding columns,
-- which CREATE OR REPLACE does allow (only at the end), but a plain
-- DROP also gives Postgres a clean slate so a future column
-- reordering or rename in 029 does not silently conflict with this
-- migration. No CASCADE — confirmed via grep that the only consumers
-- are app code (`app/api/admin/family-classification/route.ts` selects
-- only `cluster_id, algorithm_version`, and the quality route, which
-- this migration is fixing). `family_classification_review_current`
-- in 030 sources directly from the reviews table, not from this view.
drop view if exists family_classification_current;

create view family_classification_current as
select distinct on (cluster_id)
  fc.id,
  fc.cluster_id,
  fc.algorithm_version,
  fc.family_title,
  fc.family_summary,
  fc.family_kind,
  fc.dominant_topic_slug,
  fc.primary_failure_mode,
  fc.affected_surface,
  fc.likely_owner_area,
  fc.severity_rollup,
  fc.confidence,
  fc.needs_human_review,
  fc.review_reasons,
  fc.evidence,
  fc.computed_at,
  -- Topic-metadata snapshot lifted from evidence.cluster_topic_metadata
  -- (producer: lib/storage/family-classification.ts:910-927). Types
  -- mirror mv_cluster_topic_metadata so downstream consumers get
  -- consistent precision regardless of which surface they read from.
  (fc.evidence -> 'cluster_topic_metadata' ->> 'cluster_path')::text
    as cluster_path,
  (fc.evidence -> 'cluster_topic_metadata' ->> 'observation_count')::integer
    as observation_count,
  (fc.evidence -> 'cluster_topic_metadata' ->> 'classification_coverage_share')::numeric(5,4)
    as classification_coverage_share,
  (fc.evidence -> 'cluster_topic_metadata' ->> 'mixed_topic_score')::numeric(5,4)
    as mixed_topic_score,
  -- LLM provenance lifted from evidence.llm. The route's
  -- `normalizeLlmStatus` already falls back to evidence.llm.status; this
  -- promotion lets the same value be filterable / sortable directly on
  -- the view without rehydrating the full JSONB.
  (fc.evidence -> 'llm' ->> 'status')::text as llm_status,
  (fc.evidence -> 'llm' ->> 'model')::text as llm_model,
  case
    when (fc.evidence -> 'llm' ->> 'status') in (
      'succeeded',
      'failed',
      'low_confidence_fallback'
    ) then fc.computed_at
    else null
  end as llm_classified_at,
  -- Append-only table: classified_at and updated_at both resolve to
  -- the row's computed_at. If a future migration adds in-place updates
  -- (e.g. reviewer-triggered re-classification mutating the same row),
  -- updated_at must be re-derived; for v1 the alias is honest.
  fc.computed_at as classified_at,
  fc.computed_at as updated_at
from family_classifications fc
order by fc.cluster_id, fc.computed_at desc;

commit;
