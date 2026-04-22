// Central registry of the currently effective algorithm version per derivation type.
// Bumping a value here is the only way to force the enrich pass to write a new
// row into the derivation layer (existing rows at the old version remain for
// reproducibility; see docs/ARCHITECTURE.md v10 §7.4).
//
// Keep in sync with the algorithm_versions seed in
// scripts/007_three_layer_split.sql.

export const CURRENT_VERSIONS = {
  sentiment: "v2",
  category: "v2",
  impact: "v2",
  // competitor_mention shares the canonical lexicon (sentiment-lexicon.ts).
  // The sentiment v2 bump added words that are ALSO in NEGATORS (e.g.
  // "cannot"/"can't"), which changes scoreMentionSentiment's polarity
  // accounting on identical input — so mention rows written going forward
  // are no longer apples-to-apples with v1. Bump in lockstep to preserve
  // replay integrity. See scripts/011_algorithm_v2_bump.sql.
  competitor_mention: "v2",
  classification: "v1",
} as const

export type AlgorithmKind = keyof typeof CURRENT_VERSIONS

export const LEXICON_VERSION = "v1"
