-- 029_family_classifications.sql
--
-- Family Classification v1 — a per-cluster *interpretation* layer
-- sitting on top of Layer A (cluster membership) and the per-cluster
-- topic-metadata read model added by 028.
--
-- What this is:
--   * append-only record of "what the family represents" at a point in
--     time: a coherence judgement (`family_kind`), a human-readable
--     title + summary, optional dominant slug / failure mode / surface /
--     owner, a severity rollup, an LLM (or heuristic) confidence, an
--     explicit `needs_human_review` flag with `review_reasons[]`, and
--     an `evidence` JSONB snapshot of everything the classifier saw.
--
-- What this is NOT (and never becomes without an explicit follow-up):
--   * a clustering decision — membership stays embedding-first, owned
--     by `lib/storage/semantic-clusters.ts` (see CLUSTERING_DESIGN
--     §4.6). This table never re-points cluster_id, never splits or
--     merges, and never auto-promotes itself to ground truth.
--   * a phrase-tuning artifact — CATEGORY_PATTERNS and the Layer 0
--     evidence shape are unchanged.
--   * a cluster label override — `clusters.label` is left alone. A
--     family classification can carry a richer mechanism-specific
--     title (`family_title`) without overwriting the per-row label
--     used by all the existing render sites in
--     CLUSTERING_DESIGN §4.4.8.
--
-- Provenance:
--   * Apply order: this is 029, after 028 added the
--     `mv_cluster_topic_metadata` MV that the classifier reads.
--   * Older classifications are NOT deleted on re-classify — the
--     view below resolves the latest per cluster, and the older rows
--     stay queryable for audit (`computed_at` ordering).
--
-- See docs/CLUSTERING_DESIGN.md §4.7 for the architectural contract.

begin;

-- Enum-style CHECK constraints rather than real Postgres enums so a
-- future v1.1 with new family_kind values (or a renamed severity
-- bucket) can edit the constraint without a `ALTER TYPE … ADD VALUE`
-- migration that has its own gotchas (transactional restrictions
-- pre-PG12, replica lag).

create table if not exists family_classifications (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid not null references clusters(id) on delete restrict,
  algorithm_version text not null,
  family_title text not null,
  family_summary text not null,
  family_kind text not null
    check (family_kind in (
      'coherent_single_issue',
      'mixed_multi_causal',
      'needs_split_review',
      'low_evidence',
      'unclear'
    )),
  -- Optional discriminators sourced from the topic-metadata MV +
  -- LLM rationale. Nullable on purpose: a `low_evidence` family
  -- legitimately has no dominant slug, and an LLM-down deployment
  -- legitimately has no `primary_failure_mode` / `affected_surface`
  -- / `likely_owner_area`.
  dominant_topic_slug text null,
  primary_failure_mode text null,
  affected_surface text null,
  likely_owner_area text null,
  severity_rollup text not null default 'unknown'
    check (severity_rollup in ('low', 'medium', 'high', 'critical', 'unknown')),
  -- numeric(4,3) so 0.000–1.000 round-trips losslessly.
  confidence numeric(4,3) not null default 0
    check (confidence >= 0 and confidence <= 1),
  needs_human_review boolean not null default false,
  -- Open-ended set of machine-readable reason codes
  -- (e.g. `low_classification_coverage`, `high_topic_mixedness`,
  -- `llm_unavailable`). Stored as a text[] so a follow-up that adds
  -- a new code does not need a CHECK migration.
  review_reasons text[] not null default '{}',
  -- Snapshot of the inputs the classifier saw. Stored verbatim so a
  -- reviewer can audit "what did the classifier know when it wrote
  -- this title?" without having to recompute the MV at the same
  -- timestamp. See docs/CLUSTERING_DESIGN.md §4.7 for the schema.
  evidence jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);

-- Latest-per-cluster lookup (admin tables, "Family Classification" tab).
create index if not exists idx_family_classifications_cluster_computed
  on family_classifications (cluster_id, computed_at desc);

-- "Show me all v1 rows" / "compare v1 vs v2 after a bump".
create index if not exists idx_family_classifications_algorithm_version
  on family_classifications (algorithm_version);

-- Partition admin views by coherence bucket.
create index if not exists idx_family_classifications_family_kind
  on family_classifications (family_kind);

-- Quick filter for the "needs review" inbox.
create index if not exists idx_family_classifications_needs_review
  on family_classifications (needs_human_review)
  where needs_human_review = true;

-- "Find all auth families", etc. Partial because the column is
-- nullable for low-evidence rows.
create index if not exists idx_family_classifications_dominant_topic
  on family_classifications (dominant_topic_slug)
  where dominant_topic_slug is not null;

-- Latest-per-cluster view. `distinct on (cluster_id)` ordered by
-- `computed_at desc` is the same pattern used by
-- `latest_category_current` in 028 — the older rows are preserved
-- for audit but consumers see one row per cluster by default.
--
-- View, not materialized view: this is small (one row per active
-- cluster) and read on demand from the admin panel; a MV would add
-- refresh-cadence drag for no scale benefit at v1.
create or replace view family_classification_current as
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
  fc.computed_at
from family_classifications fc
order by fc.cluster_id, fc.computed_at desc;

-- Register the new algorithm version kind so the version registry
-- gains a `family_classification` row (current_effective = v1).
alter table algorithm_versions
  drop constraint if exists algorithm_versions_kind_check;
do $$
declare
  allowed_kinds text;
begin
  -- Rebuild the CHECK from currently present kinds plus the new
  -- family_classification kind. This keeps migration 029 compatible
  -- with environments that already carry extra historical kinds.
  select string_agg(quote_literal(kind), ', ' order by kind)
    into allowed_kinds
  from (
    select kind from algorithm_versions
    union
    select 'family_classification'
  ) kinds;

  execute format(
    'alter table algorithm_versions add constraint algorithm_versions_kind_check check (kind in (%s))',
    allowed_kinds
  );
end
$$;

insert into algorithm_versions (kind, version, current_effective, notes)
values (
  'family_classification',
  'v1',
  true,
  'Heuristic-first family kind + optional LLM title/summary; see docs/CLUSTERING_DESIGN.md §4.7'
)
on conflict do nothing;

-- RLS: read open to anon/authenticated (parity with the other
-- derivation tables); writes only via service_role.
alter table family_classifications enable row level security;

drop policy if exists "public_read_family_classifications" on family_classifications;
drop policy if exists "service_rw_family_classifications" on family_classifications;

create policy "public_read_family_classifications"
  on family_classifications for select to anon, authenticated using (true);

create policy "service_rw_family_classifications"
  on family_classifications for all to service_role using (true) with check (true);

commit;
