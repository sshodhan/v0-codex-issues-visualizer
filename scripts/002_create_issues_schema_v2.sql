-- Codex Issues Visualizer Database Schema v2
-- Creates tables for storing scraped issues from various sources

-- Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Allow public read sources" ON sources;
DROP POLICY IF EXISTS "Allow public read categories" ON categories;
DROP POLICY IF EXISTS "Allow public read issues" ON issues;
DROP POLICY IF EXISTS "Allow public read scrape_logs" ON scrape_logs;
DROP POLICY IF EXISTS "Service role full access sources" ON sources;
DROP POLICY IF EXISTS "Service role full access categories" ON categories;
DROP POLICY IF EXISTS "Service role full access issues" ON issues;
DROP POLICY IF EXISTS "Service role full access scrape_logs" ON scrape_logs;

-- Sources table (Reddit, App Store, HN, Google, etc.)
CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  icon TEXT,
  base_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Categories for issue classification
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#6366f1',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Main issues table
CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  author TEXT,
  sentiment TEXT CHECK (sentiment IN ('positive', 'negative', 'neutral')),
  sentiment_score DECIMAL(3, 2) DEFAULT 0,
  impact_score INTEGER DEFAULT 1 CHECK (impact_score BETWEEN 1 AND 10),
  frequency_count INTEGER DEFAULT 1,
  upvotes INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  published_at TIMESTAMPTZ,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_id, external_id)
);

-- Scrape logs for tracking refresh history
CREATE TABLE IF NOT EXISTS scrape_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  issues_found INTEGER DEFAULT 0,
  issues_added INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_issues_source ON issues(source_id);
CREATE INDEX IF NOT EXISTS idx_issues_category ON issues(category_id);
CREATE INDEX IF NOT EXISTS idx_issues_sentiment ON issues(sentiment);
CREATE INDEX IF NOT EXISTS idx_issues_published_at ON issues(published_at);
CREATE INDEX IF NOT EXISTS idx_issues_scraped_at ON issues(scraped_at);
CREATE INDEX IF NOT EXISTS idx_scrape_logs_source ON scrape_logs(source_id);

-- Insert default sources
INSERT INTO sources (name, slug, icon, base_url) VALUES
  ('Reddit', 'reddit', 'MessageSquare', 'https://reddit.com'),
  ('iOS App Store', 'appstore', 'Apple', 'https://apps.apple.com'),
  ('Hacker News', 'hackernews', 'Newspaper', 'https://news.ycombinator.com'),
  ('Google Search', 'google', 'Search', 'https://google.com')
ON CONFLICT (slug) DO NOTHING;

-- Insert default categories
INSERT INTO categories (name, slug, color) VALUES
  ('Performance', 'performance', '#ef4444'),
  ('Bug', 'bug', '#f97316'),
  ('Feature Request', 'feature-request', '#8b5cf6'),
  ('Documentation', 'documentation', '#06b6d4'),
  ('Integration', 'integration', '#10b981'),
  ('Pricing', 'pricing', '#f59e0b'),
  ('Security', 'security', '#dc2626'),
  ('UX/UI', 'ux-ui', '#ec4899'),
  ('API', 'api', '#3b82f6'),
  ('Other', 'other', '#6b7280')
ON CONFLICT (slug) DO NOTHING;

-- Enable Row Level Security
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_logs ENABLE ROW LEVEL SECURITY;

-- Public read policies (anonymous users can view data)
CREATE POLICY "public_read_sources" ON sources FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "public_read_categories" ON categories FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "public_read_issues" ON issues FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "public_read_scrape_logs" ON scrape_logs FOR SELECT TO anon, authenticated USING (true);

-- Allow inserts/updates for service role (used by API routes with service key)
CREATE POLICY "service_insert_sources" ON sources FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_sources" ON sources FOR UPDATE TO service_role USING (true);
CREATE POLICY "service_delete_sources" ON sources FOR DELETE TO service_role USING (true);

CREATE POLICY "service_insert_categories" ON categories FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_categories" ON categories FOR UPDATE TO service_role USING (true);
CREATE POLICY "service_delete_categories" ON categories FOR DELETE TO service_role USING (true);

CREATE POLICY "service_insert_issues" ON issues FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_issues" ON issues FOR UPDATE TO service_role USING (true);
CREATE POLICY "service_delete_issues" ON issues FOR DELETE TO service_role USING (true);

CREATE POLICY "service_insert_scrape_logs" ON scrape_logs FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service_update_scrape_logs" ON scrape_logs FOR UPDATE TO service_role USING (true);
CREATE POLICY "service_delete_scrape_logs" ON scrape_logs FOR DELETE TO service_role USING (true);
