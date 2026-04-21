-- Lock in the clustering invariants introduced by script 005 and add the
-- atomic helpers the persist path relies on. Safe to run after 005.

-- 1) Backfill any remaining NULL cluster_keys to the empty-title sentinel so
--    the NOT NULL constraint and the partial unique index below can hold.
UPDATE issues SET cluster_key = 'title:empty' WHERE cluster_key IS NULL;

ALTER TABLE issues ALTER COLUMN cluster_key SET NOT NULL;
ALTER TABLE issues ALTER COLUMN cluster_key SET DEFAULT 'title:empty';

-- 2) Enforce one canonical per cluster at the DB, not just in application
--    code. Concurrent scrapers racing on the same cluster_key will have at
--    most one INSERT succeed; the other trips 23505 and the persist path
--    recovers by attaching as a non-canonical member.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_unique_canonical_per_cluster
  ON issues(cluster_key) WHERE is_canonical = true;

-- 3) Atomic frequency_count bump so concurrent duplicate inserts cannot lose
--    increments via read-modify-write. Called via supabase.rpc() from the
--    non-canonical persist path.
CREATE OR REPLACE FUNCTION increment_canonical_frequency(canonical_id UUID)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE issues
  SET frequency_count = frequency_count + 1
  WHERE id = canonical_id;
$$;
