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
  competitor_mention: "v1",
  classification: "v1",
} as const

export type AlgorithmKind = keyof typeof CURRENT_VERSIONS

export const LEXICON_VERSION = "v1"
