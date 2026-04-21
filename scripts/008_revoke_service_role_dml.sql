-- ============================================================================
-- Migration 008: enforce RPC-only writes via service_role DML revoke
--
-- Supabase's service_role bypasses RLS entirely, so the previous "no service
-- role RLS policy" approach in 007 did not actually prevent a direct
-- .from("observations").insert/update/delete from a service-role client.
--
-- This migration revokes INSERT/UPDATE/DELETE on every append-only table from
-- service_role and leaves only SELECT + EXECUTE on the record_* RPCs. The
-- RPCs are SECURITY DEFINER and owned by postgres (via the migration role),
-- so they retain full DML privileges when invoked — only direct PostgREST
-- table writes from a service-role JWT are blocked.
--
-- After this runs, the append-only invariant is enforced at the privilege
-- layer in addition to the application layer. See docs/ARCHITECTURE.md v10
-- §§5.6, 11 (Migration Runbook).
-- ============================================================================

begin;

-- Evidence layer: service_role may read, execute record_* RPCs, and nothing else.
revoke insert, update, delete, truncate on table
  observations,
  observation_revisions,
  engagement_snapshots,
  ingestion_artifacts
from service_role;

-- Derivation layer: same. Bumping algorithm_version inserts new rows via
-- record_* RPCs, never updates existing ones.
revoke insert, update, delete, truncate on table
  sentiment_scores,
  category_assignments,
  impact_scores,
  competitor_mentions
from service_role;

-- Classifications and their reviews: immutable. LLM baseline writes via
-- record_classification; reviewer decisions append via
-- record_classification_review.
revoke insert, update, delete, truncate on table
  classifications,
  classification_reviews
from service_role;

-- Ensure SELECT is explicitly granted (PostgREST needs SELECT for the anon
-- read policies to produce rows over the REST surface; service_role reads
-- should remain unaffected by the revokes above).
grant select on table
  observations,
  observation_revisions,
  engagement_snapshots,
  ingestion_artifacts,
  sentiment_scores,
  category_assignments,
  impact_scores,
  competitor_mentions,
  classifications,
  classification_reviews
to service_role;

-- Reference tables and operational state stay writable by service_role:
--   sources, categories           — seeded once, occasionally updated by ops
--   scrape_logs                   — written directly by lib/scrapers/index.ts
--   algorithm_versions            — version registry, bumped by ops
--   clusters, cluster_members     — rebuild path runs via RPCs today but
--                                   leaving DML open preserves the ability
--                                   to repair cluster state via direct SQL
--                                   in an incident.
-- No REVOKE on those.

-- Belt-and-braces: ensure future tables default to REVOKE for append-only
-- semantics would need to be added explicitly. This migration does not
-- touch default privileges because the default scope is too wide.

commit;
