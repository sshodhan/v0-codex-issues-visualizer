// Central registry of the currently effective algorithm version per derivation type.
// Bumping a value here is the only way to force the enrich pass to write a new
// row into the derivation layer (existing rows at the old version remain for
// reproducibility; see docs/ARCHITECTURE.md v10 §7.4).
//
// Keep in sync with the algorithm_versions seed in
// scripts/007_three_layer_split.sql.

export const CURRENT_VERSIONS = {
  sentiment: "v2",
  // v5 (2026-04): structural fixes to categorizeIssue — title scored
  // separately from body and weighted 4×, [BUG]/[FEATURE]/… template
  // prefixes stripped before matching, per-slug thresholds (model-quality
  // 3, pricing 4, others 2), and the matcher returns structured evidence
  // (matched phrases + per-slug scores + margin + runner-up) which is
  // persisted into the new category_assignments.evidence JSONB column for
  // SQL-side classification audits. The CATEGORY_PATTERNS phrase table is
  // unchanged from v4. See scripts/025_topic_classifier_v5_bump.sql,
  // scripts/026_category_assignments_evidence.sql, and
  // lib/scrapers/shared.ts → categorizeIssue.
  category: "v5",
  impact: "v2",
  // competitor_mention shares the canonical lexicon (sentiment-lexicon.ts).
  // The sentiment v2 bump added words that are ALSO in NEGATORS (e.g.
  // "cannot"/"can't"), which changes scoreMentionSentiment's polarity
  // accounting on identical input — so mention rows written going forward
  // are no longer apples-to-apples with v1. Bump in lockstep to preserve
  // replay integrity. See scripts/011_algorithm_v2_bump.sql.
  competitor_mention: "v2",
  classification: "v1",
  observation_embedding: "v1",
  // v2 (2026-04): the labeller pipeline grew prompt context (Topic +
  // recurring error codes), small-→-large model escalation mirroring the
  // classifier, and a deterministic fallback derived from cluster
  // contents so the UI no longer renders "Unnamed family". See
  // lib/storage/cluster-label-fallback.ts and
  // docs/CLUSTERING_DESIGN.md §4.4.
  semantic_cluster_label: "v2",
  // v1 of the regex bug-fingerprint extractor. Produces error codes, top
  // stack frame, env tokens, and repro counters from title + body. Feeds
  // into a compound cluster key label that splits over-aggregated
  // semantic clusters when they contain reports with distinct root
  // causes. See scripts/013_bug_fingerprints.sql.
  bug_fingerprint: "v1",
} as const

export type AlgorithmKind = keyof typeof CURRENT_VERSIONS

export const LEXICON_VERSION = "v1"
