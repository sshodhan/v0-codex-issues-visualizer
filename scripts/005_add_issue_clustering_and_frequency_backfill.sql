-- Add deterministic clustering columns and backfill canonical/frequency values.

ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS cluster_key TEXT,
  ADD COLUMN IF NOT EXISTS canonical_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_issues_cluster_key ON issues(cluster_key);
CREATE INDEX IF NOT EXISTS idx_issues_canonical ON issues(is_canonical);

-- Deterministic title normalization and key generation.
-- Kept in lock-step with buildIssueClusterKey() in lib/scrapers/shared.ts:
-- md5 of lower → strip-non-alphanumeric → collapse-whitespace, first 16 hex chars.
-- Regex patterns use single-backslash escapes so the engine actually matches the
-- \s whitespace class under the default standard_conforming_strings setting.
UPDATE issues
SET cluster_key = CONCAT(
  'title:',
  SUBSTRING(
    md5(
      trim(
        regexp_replace(
          regexp_replace(lower(coalesce(title, '')), '[^a-z0-9\s]+', ' ', 'g'),
          '\s+',
          ' ',
          'g'
        )
      )
    )
    FROM 1 FOR 16
  )
)
WHERE cluster_key IS NULL OR cluster_key = '';

WITH ranked AS (
  SELECT
    id,
    cluster_key,
    ROW_NUMBER() OVER (PARTITION BY cluster_key ORDER BY created_at ASC, id ASC) AS row_num,
    COUNT(*) OVER (PARTITION BY cluster_key) AS cluster_size,
    FIRST_VALUE(id) OVER (PARTITION BY cluster_key ORDER BY created_at ASC, id ASC) AS canonical_id
  FROM issues
  WHERE cluster_key IS NOT NULL
)
UPDATE issues AS i
SET
  is_canonical = ranked.row_num = 1,
  canonical_issue_id = CASE WHEN ranked.row_num = 1 THEN NULL ELSE ranked.canonical_id END,
  frequency_count = CASE WHEN ranked.row_num = 1 THEN ranked.cluster_size ELSE 1 END
FROM ranked
WHERE ranked.id = i.id;
