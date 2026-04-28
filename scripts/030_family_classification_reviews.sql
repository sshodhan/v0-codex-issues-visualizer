-- 030_family_classification_reviews.sql
--
-- Family Classification QA Reviews — append-only reviewer feedback on
-- whether a `family_classifications` row got the answer right. This is
-- a classifier-quality evaluation loop, not a ticketing workflow:
--   * one row per review event (no upsert);
--   * verdict is one of correct / incorrect / unclear;
--   * for incorrect rows the reviewer captures which layer most likely
--     caused the error (`error_layer`) and what kind of error it was
--     (`error_reason`);
--   * an `evidence_snapshot` JSONB freezes the inputs the reviewer saw
--     so a later analysis can audit "what was on screen when this
--     verdict was made?" without recomputing the upstream MV.
--
-- What this is NOT (and never becomes without an explicit follow-up):
--   * an approve/reject workflow — reviews never mutate
--     `family_classifications` and never change `quality_bucket`.
--   * a ticket queue — there is no filed/dismissed/deferred state, no
--     `ticket_url` field, no external-issue mirror.
--   * a routing surface — reviews are not consumed by clustering or
--     classification; they exist purely to feed future precision /
--     recall analysis ("are rows we marked safe_to_trust actually
--     correct? do operators agree with our needs_review flagging?").
--
-- Provenance:
--   * Apply order: this is 030, after 029 created
--     `family_classifications` (the FK target).
--   * Append-only — older review rows for the same classification stay
--     queryable; the `family_classification_review_current` view
--     resolves "latest review per classification" for dashboard reads.

begin;

-- Enum-style CHECK constraints (matches 029) so a future v1.1 with new
-- error_reason codes can edit the constraint without an
-- `ALTER TYPE … ADD VALUE` migration.

create table if not exists family_classification_reviews (
  id uuid primary key default gen_random_uuid(),
  -- on delete cascade: if a classification row gets purged, drop its
  -- review history with it. Reviews are valueless without the
  -- classification context they were judging.
  classification_id uuid not null references family_classifications(id) on delete cascade,
  cluster_id uuid not null references clusters(id) on delete cascade,
  -- Reviewer's verdict. `unclear` is its own state (not a missing
  -- value) so a follow-up review can definitively flip it to
  -- correct/incorrect later.
  review_verdict text not null
    check (review_verdict in (
      'correct',
      'incorrect',
      'unclear'
    )),
  -- What the reviewer thinks the family_kind should have been. Required
  -- when error_reason = 'wrong_family_kind' (validated at the API
  -- layer); optional otherwise.
  expected_family_kind text null
    check (expected_family_kind in (
      'coherent_single_issue',
      'mixed_multi_causal',
      'needs_split_review',
      'low_evidence',
      'unclear'
    )),
  -- Snapshot of the actual family_kind on the classification at review
  -- time. Stored separately from the FK so analysis queries don't have
  -- to join through to the classification table to compare expected
  -- vs actual.
  actual_family_kind text null,
  -- Snapshot of the quality bucket the row was in at review time
  -- (computeFamilyQualityBucket output). Lets us answer
  -- "of rows marked safe_to_trust, how many were actually correct?".
  quality_bucket text null
    check (quality_bucket in (
      'safe_to_trust',
      'needs_review',
      'input_problem'
    )),
  -- Which architectural layer the reviewer believes caused the error.
  -- Required for incorrect verdicts (validated at the API layer);
  -- nullable here so correct/unclear reviews don't have to fake one.
  error_layer text null
    check (error_layer in (
      'layer_0_topic',
      'layer_a_cluster',
      'family_classification',
      'representatives',
      'llm_enrichment',
      'data_quality',
      'unknown'
    )),
  error_reason text null
    check (error_reason in (
      'wrong_family_kind',
      'bad_family_title',
      'bad_family_summary',
      'bad_representatives',
      'bad_cluster_membership',
      'low_layer0_coverage',
      'wrong_layer0_topic_distribution',
      'llm_hallucinated',
      'llm_too_generic',
      'singleton_not_recurring',
      'mixed_cluster_should_split',
      'false_safe_to_trust',
      'false_needs_review',
      'false_input_problem',
      'other'
    )),
  notes text null,
  reviewed_by text null default 'local_admin',
  reviewed_at timestamptz not null default now(),
  -- Frozen audit context. Captures family_title/family_summary,
  -- family_kind, quality bucket, review_reasons, and a bounded preview
  -- of representatives + matched phrases so a reviewer of the reviewer
  -- can see "what did they have on screen?". Bounded by the API layer.
  evidence_snapshot jsonb not null default '{}'::jsonb
);

-- Latest-per-classification lookup ("what's the current verdict on this
-- classification?"). Composite to support the view below efficiently.
create index if not exists idx_family_classification_reviews_classification_reviewed
  on family_classification_reviews (classification_id, reviewed_at desc);

-- Filter by cluster ("show me all reviews for this cluster's history of
-- classifications").
create index if not exists idx_family_classification_reviews_cluster
  on family_classification_reviews (cluster_id);

-- Tile / summary aggregations partition by these.
create index if not exists idx_family_classification_reviews_verdict
  on family_classification_reviews (review_verdict);

create index if not exists idx_family_classification_reviews_quality_bucket
  on family_classification_reviews (quality_bucket)
  where quality_bucket is not null;

create index if not exists idx_family_classification_reviews_error_layer
  on family_classification_reviews (error_layer)
  where error_layer is not null;

create index if not exists idx_family_classification_reviews_error_reason
  on family_classification_reviews (error_reason)
  where error_reason is not null;

-- Recent-activity index for the "latest reviews" panel.
create index if not exists idx_family_classification_reviews_reviewed_at
  on family_classification_reviews (reviewed_at desc);

-- Latest-review-per-classification view. Mirrors the
-- `family_classification_current` pattern in 029: append-only rows in
-- the table, `distinct on (classification_id) order by reviewed_at desc`
-- in the view. Older reviews stay queryable for audit ("did the verdict
-- change after the LLM block was added?") via the table directly.
create or replace view family_classification_review_current as
select distinct on (classification_id)
  fr.id,
  fr.classification_id,
  fr.cluster_id,
  fr.review_verdict,
  fr.expected_family_kind,
  fr.actual_family_kind,
  fr.quality_bucket,
  fr.error_layer,
  fr.error_reason,
  fr.notes,
  fr.reviewed_by,
  fr.reviewed_at,
  fr.evidence_snapshot
from family_classification_reviews fr
order by fr.classification_id, fr.reviewed_at desc;

-- RLS: read open to anon/authenticated (parity with the other
-- derivation tables); writes only via service_role.
alter table family_classification_reviews enable row level security;

drop policy if exists "public_read_family_classification_reviews" on family_classification_reviews;
drop policy if exists "service_rw_family_classification_reviews" on family_classification_reviews;

create policy "public_read_family_classification_reviews"
  on family_classification_reviews for select to anon, authenticated using (true);

create policy "service_rw_family_classification_reviews"
  on family_classification_reviews for all to service_role using (true) with check (true);

commit;
