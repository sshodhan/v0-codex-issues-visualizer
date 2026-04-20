-- Add relevance reason for debugging relevance matches and clean obvious false positives.
ALTER TABLE issues
ADD COLUMN IF NOT EXISTS relevance_reason TEXT;

-- Clean recently ingested Reddit/HN records that match known excluded patterns
-- and do not match any scoped Codex include pattern.
WITH recent_candidates AS (
  SELECT i.id,
    LOWER(COALESCE(i.title, '') || ' ' || COALESCE(i.content, '')) AS body
  FROM issues i
  JOIN sources s ON s.id = i.source_id
  WHERE s.slug IN ('reddit', 'hackernews')
    AND i.scraped_at >= NOW() - INTERVAL '14 days'
), to_delete AS (
  SELECT id
  FROM recent_candidates
  WHERE (
    body ~ 'microsoft\\s+copilot'
    OR body ~ 'copilot\\s+for\\s+sales'
    OR body ~ 'copilot\\s+for\\s+(microsoft\\s+365|finance|service|security)'
    OR body ~ 'power\\s+platform\\s+copilot'
  )
  AND NOT (
    body ~ 'openai\\s+codex'
    OR body ~ 'chatgpt\\s+codex'
    OR body ~ 'codex\\s+cli'
    OR body ~ 'openai/codex'
    OR body ~ 'codex.{0,30}(openai|chatgpt)'
    OR body ~ '(openai|chatgpt).{0,30}codex'
    OR body ~ 'codex.{0,30}(terminal|cli tool|command line)'
    OR body ~ '(terminal|cli tool|command line).{0,30}codex'
  )
)
DELETE FROM issues i
USING to_delete d
WHERE i.id = d.id;
