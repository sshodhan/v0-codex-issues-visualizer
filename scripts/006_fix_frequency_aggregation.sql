-- Fix frequency aggregation for repeated sightings of the same source/external issue.
-- Safe to run multiple times.

ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW();

UPDATE issues
SET last_seen_at = COALESCE(last_seen_at, updated_at, scraped_at, created_at, NOW())
WHERE last_seen_at IS NULL;

ALTER TABLE issues
  ALTER COLUMN frequency_count SET DEFAULT 1;

UPDATE issues
SET frequency_count = 1
WHERE frequency_count IS NULL OR frequency_count < 1;

CREATE OR REPLACE FUNCTION upsert_issue_observation(issue_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected_id UUID;
BEGIN
  INSERT INTO issues (
    source_id,
    category_id,
    external_id,
    title,
    content,
    url,
    author,
    sentiment,
    sentiment_score,
    impact_score,
    frequency_count,
    upvotes,
    comments_count,
    published_at,
    relevance_reason,
    scraped_at,
    created_at,
    updated_at,
    last_seen_at
  )
  VALUES (
    (issue_payload->>'source_id')::UUID,
    NULLIF(issue_payload->>'category_id', '')::UUID,
    NULLIF(issue_payload->>'external_id', ''),
    issue_payload->>'title',
    issue_payload->>'content',
    issue_payload->>'url',
    issue_payload->>'author',
    COALESCE(NULLIF(issue_payload->>'sentiment', ''), 'neutral'),
    COALESCE((issue_payload->>'sentiment_score')::DECIMAL, 0),
    COALESCE((issue_payload->>'impact_score')::INTEGER, 1),
    1,
    COALESCE((issue_payload->>'upvotes')::INTEGER, 0),
    COALESCE((issue_payload->>'comments_count')::INTEGER, 0),
    NULLIF(issue_payload->>'published_at', '')::TIMESTAMPTZ,
    issue_payload->>'relevance_reason',
    COALESCE(NULLIF(issue_payload->>'scraped_at', '')::TIMESTAMPTZ, NOW()),
    COALESCE(NULLIF(issue_payload->>'created_at', '')::TIMESTAMPTZ, NOW()),
    COALESCE(NULLIF(issue_payload->>'updated_at', '')::TIMESTAMPTZ, NOW()),
    COALESCE(NULLIF(issue_payload->>'last_seen_at', '')::TIMESTAMPTZ, NOW())
  )
  ON CONFLICT (source_id, external_id)
  DO UPDATE SET
    category_id = EXCLUDED.category_id,
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    url = EXCLUDED.url,
    author = EXCLUDED.author,
    sentiment = EXCLUDED.sentiment,
    sentiment_score = EXCLUDED.sentiment_score,
    impact_score = EXCLUDED.impact_score,
    upvotes = EXCLUDED.upvotes,
    comments_count = EXCLUDED.comments_count,
    published_at = EXCLUDED.published_at,
    relevance_reason = EXCLUDED.relevance_reason,
    scraped_at = EXCLUDED.scraped_at,
    updated_at = EXCLUDED.updated_at,
    last_seen_at = EXCLUDED.last_seen_at,
    frequency_count = COALESCE(issues.frequency_count, 1) + 1
  RETURNING id INTO affected_id;

  RETURN affected_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_issue_observation(JSONB) TO service_role;
