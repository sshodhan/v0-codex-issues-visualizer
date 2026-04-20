export interface Source {
  id: string
  name: string
  slug: string
  icon: string | null
  base_url: string | null
  created_at: string
}

export interface Category {
  id: string
  name: string
  slug: string
  color: string
  created_at: string
}

export interface Issue {
  id: string
  source_id: string
  category_id: string | null
  external_id: string | null
  title: string
  content: string | null
  url: string | null
  author: string | null
  sentiment: 'positive' | 'negative' | 'neutral'
  sentiment_score: number
  impact_score: number
  frequency_count: number
  upvotes: number
  comments_count: number
  published_at: string | null
  scraped_at: string
  created_at: string
  updated_at: string
  // Joined data
  source?: Source
  category?: Category
}

export interface ScrapeLog {
  id: string
  source_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  issues_found: number
  issues_added: number
  error_message: string | null
  started_at: string
  completed_at: string | null
  source?: Source
}

export interface DashboardStats {
  total_issues: number
  issues_by_sentiment: {
    positive: number
    negative: number
    neutral: number
  }
  issues_by_source: Record<string, number>
  issues_by_category: Record<string, { count: number; color: string }>
  trend_data: Array<{
    date: string
    count: number
    sentiment: string
  }>
  priority_matrix: Array<{
    id: string
    title: string
    impact_score: number
    frequency_count: number
    sentiment: string
    category: string
  }>
  top_issues: Issue[]
  last_scrape: ScrapeLog | null
}

export interface ScrapeResult {
  source: string
  issues_found: number
  issues_added: number
  status: 'success' | 'error'
  error?: string
}
