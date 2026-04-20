-- Codex Issues Visualizer Database Schema v4
-- Adds GitHub Discussions and community.openai.com as first-class scraping
-- sources. These are the two highest-signal user feedback channels that the
-- original scraper loop missed (issues/REST doesn't index Discussions, and
-- the OpenAI community forum is not surfaced anywhere else).

INSERT INTO sources (name, slug, icon, base_url) VALUES
  ('GitHub Discussions', 'github-discussions', 'MessagesSquare', 'https://github.com'),
  ('OpenAI Community', 'openai-community', 'Users', 'https://community.openai.com')
ON CONFLICT (slug) DO NOTHING;
