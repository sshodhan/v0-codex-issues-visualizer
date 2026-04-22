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

// ============================================================================
// Evidence layer — raw captured data, append-only
// ============================================================================

export interface Observation {
  id: string
  source_id: string
  external_id: string
  title: string
  content: string | null
  url: string | null
  author: string | null
  published_at: string | null
  captured_at: string
}

export interface ObservationRevision {
  id: string
  observation_id: string
  revision_number: number
  title: string | null
  content: string | null
  author: string | null
  seen_at: string
}

export interface EngagementSnapshot {
  id: string
  observation_id: string
  upvotes: number
  comments_count: number
  captured_at: string
}

// ============================================================================
// Derivation layer — versioned, immutable
// ============================================================================

export type SentimentLabel = "positive" | "negative" | "neutral"

export interface SentimentScore {
  observation_id: string
  algorithm_version: string
  score: number
  label: SentimentLabel
  keyword_presence: number
  computed_at: string
}

export interface CategoryAssignment {
  observation_id: string
  algorithm_version: string
  category_id: string
  confidence: number
  computed_at: string
}

export interface ImpactScore {
  observation_id: string
  algorithm_version: string
  score: number
  inputs_jsonb: Record<string, unknown>
  computed_at: string
}

export interface BugFingerprintRow {
  id: string
  observation_id: string
  algorithm_version: string
  error_code: string | null
  top_stack_frame: string | null
  top_stack_frame_hash: string | null
  cli_version: string | null
  os: string | null
  shell: string | null
  editor: string | null
  model_id: string | null
  repro_markers: number
  keyword_presence: number
  llm_subcategory: string | null
  llm_primary_tag: string | null
  cluster_key_compound: string | null
  computed_at: string
}

export interface CompetitorMention {
  observation_id: string
  competitor: string
  sentence_window: string | null
  sentiment_score: number | null
  confidence: number | null
  lexicon_version: string
  algorithm_version: string
  computed_at: string
}

export interface Classification {
  id: string
  observation_id: string | null
  prior_classification_id: string | null
  report_text: string
  category: string
  subcategory: string
  severity: string
  status: string
  reproducibility: string
  impact: string
  confidence: number
  summary: string
  root_cause_hypothesis: string
  suggested_fix: string
  evidence_quotes: string[]
  alternate_categories: string[]
  tags: string[]
  needs_human_review: boolean
  review_reasons: string[]
  model_used: string | null
  retried_with_large_model: boolean
  algorithm_version: string
  raw_json: unknown
  created_at: string
}

export interface ClassificationReview {
  id: string
  classification_id: string
  status: string | null
  category: string | null
  severity: string | null
  needs_human_review: boolean | null
  reviewer_notes: string | null
  reviewed_by: string
  reviewed_at: string
}

// ============================================================================
// Aggregation layer — clusters, materialized-view row shapes
// ============================================================================

export interface Cluster {
  id: string
  cluster_key: string
  canonical_observation_id: string
  status: string
  label: string | null
  label_rationale: string | null
  label_confidence: number | null
  label_model: string | null
  label_algorithm_version: string | null
  labeling_updated_at: string | null
  created_at: string
}

export interface ClusterMember {
  id: string
  cluster_id: string
  observation_id: string
  attached_at: string
  detached_at: string | null
}

/**
 * Shape of one row from `mv_observation_current` — the primary read surface
 * for dashboard API routes. Joins the latest derivation per observation
 * plus current cluster membership and the latest engagement snapshot.
 */
export interface ObservationCurrent {
  observation_id: string
  source_id: string
  external_id: string
  title: string
  content: string | null
  url: string | null
  author: string | null
  published_at: string | null
  captured_at: string
  cluster_id: string | null
  cluster_key: string | null
  is_canonical: boolean
  frequency_count: number | null
  sentiment: SentimentLabel | null
  sentiment_score: number | null
  category_id: string | null
  impact_score: number | null
  upvotes: number | null
  comments_count: number | null
  // Bug-fingerprint columns (v3 — see scripts/012_bug_fingerprints_v3.sql).
  // All nullable: an observation is valid without a fingerprint row, and
  // during the v3 rollout most rows will have NULL here until the backfill
  // runs.
  error_code?: string | null
  top_stack_frame?: string | null
  top_stack_frame_hash?: string | null
  cli_version?: string | null
  fp_os?: string | null
  fp_shell?: string | null
  fp_editor?: string | null
  model_id?: string | null
  repro_markers?: number | null
  fp_keyword_presence?: number | null
  llm_subcategory?: string | null
  llm_primary_tag?: string | null
  fingerprint_algorithm_version?: string | null
  // Joined relations for API responses
  source?: Source
  category?: Category
}

export interface ScrapeLog {
  id: string
  source_id: string
  status: "pending" | "running" | "completed" | "failed"
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
  top_issues: ObservationCurrent[]
  last_scrape: ScrapeLog | null
}

export interface ScrapeResult {
  source: string
  issues_found: number
  issues_added: number
  status: "success" | "error"
  error?: string
}

/**
 * Legacy `Issue` shape kept for providers that still return
 * `Partial<Issue>` — the enrich pass will split these into evidence +
 * derivation writes via lib/storage/. Providers should migrate to
 * returning CapturedRecord directly; Issue is a compatibility shim.
 */
export interface Issue {
  id?: string
  source_id: string
  /**
   * Optional hint from the provider carrying the source's slug — used by
   * the enrich pass to thread `source_slug` into `impact_scores.inputs_jsonb`
   * so impact v2 (source-authority weighted) is recomputable from inputs
   * per ARCHITECTURE §3.1b. Providers that don't set it fall back to a
   * lookup via source_id; the impact row still stores the slug to unblock
   * replay even if that fallback is ever removed.
   */
  source_slug?: string
  category_id?: string | null
  external_id: string
  title: string
  content: string | null
  url: string | null
  author: string | null
  sentiment: SentimentLabel
  sentiment_score: number
  /**
   * Topic-noun / status-word hit count (bug/error/crash/fail/regression
   * tense variants). Independent of polarity; populated by
   * analyzeSentiment and threaded into the derivation layer's
   * `sentiment_scores.keyword_presence` column so the urgency layer can
   * reason about bug-topic density separately from valence.
   *
   * Optional for back-compat with any future provider; the enrich pass
   * treats `undefined` as 0.
   */
  keyword_presence?: number
  impact_score: number
  frequency_count?: number
  upvotes: number
  comments_count: number
  published_at: string | null
  relevance_reason?: string | null
  scraped_at?: string
  last_seen_at?: string
  created_at?: string
  updated_at?: string
  source?: Source
  category?: Category
  /**
   * Raw upstream API payload for this record. When populated, the scraper
   * orchestrator forwards it to `ingestion_artifacts` for replay
   * (docs/ARCHITECTURE.md v10 §5.1). Not all providers populate this yet;
   * providers that do NOT set `_raw` skip artifact capture.
   */
  _raw?: unknown
}
