-- Codex Issues Visualizer Database Schema v3
-- Adds Stack Overflow as a first-class scraping source.

INSERT INTO sources (name, slug, icon, base_url) VALUES
  ('Stack Overflow', 'stackoverflow', 'Code2', 'https://stackoverflow.com')
ON CONFLICT (slug) DO NOTHING;

-- Enable trigram extension first so the index below can be created safely.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Helpful indexes for the new analytics surfaces (competitive mentions
-- searches over `content` substring patterns).
CREATE INDEX IF NOT EXISTS idx_issues_content_trgm
  ON issues USING gin (lower(content) gin_trgm_ops);
