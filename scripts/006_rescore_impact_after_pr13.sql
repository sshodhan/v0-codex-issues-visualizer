-- N-6 pre-flight backup snapshot prior to running scripts/006_rescore_impact_after_pr13.ts
--
-- Creates a backup table named `issues_prerescore_backup_YYYYMMDD` where
-- YYYYMMDD is today's UTC date, snapshots the three rescored columns, and
-- adds a primary key on `id` for fast rollback joins.
--
-- Safe to re-run: `CREATE TABLE IF NOT EXISTS ... AS SELECT` is a no-op if
-- the table already exists (same date), and the PK is only added when
-- missing. Running on a different UTC day creates a separate backup table;
-- drop older backups explicitly when cleaning up.

DO $$
DECLARE
  ts TEXT := to_char(timezone('UTC', now()), 'YYYYMMDD');
  tbl TEXT := 'issues_prerescore_backup_' || ts;
  pk_exists BOOLEAN;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I AS SELECT id, sentiment, sentiment_score, impact_score FROM issues',
    tbl
  );

  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = tbl AND c.contype = 'p'
  ) INTO pk_exists;

  IF NOT pk_exists THEN
    EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (id)', tbl);
  END IF;

  RAISE NOTICE 'N-6 backup ready: % (rows=%)',
    tbl,
    (SELECT n FROM (SELECT count(*) AS n FROM issues) s);
END $$;

-- ROLLBACK (manual; replace YYYYMMDD with the date actually used):
-- UPDATE issues AS i
-- SET sentiment = b.sentiment,
--     sentiment_score = b.sentiment_score,
--     impact_score = b.impact_score
-- FROM issues_prerescore_backup_YYYYMMDD AS b
-- WHERE i.id = b.id
--   AND (
--     i.sentiment IS DISTINCT FROM b.sentiment OR
--     i.sentiment_score IS DISTINCT FROM b.sentiment_score OR
--     i.impact_score IS DISTINCT FROM b.impact_score
--   );

-- CLEANUP (after the rescore is verified and rollback is no longer needed):
-- DROP TABLE IF EXISTS issues_prerescore_backup_YYYYMMDD;
