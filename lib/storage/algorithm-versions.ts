// Central registry of the currently effective algorithm version per derivation type.
// Bumping a value here is the only way to force the enrich pass to write a new
// row into the derivation layer (existing rows at the old version remain for
// reproducibility; see docs/ARCHITECTURE.md v10 §7.4).
//
// Keep in sync with the algorithm_versions seed in
// scripts/007_three_layer_split.sql.

export const CURRENT_VERSIONS = {
  sentiment: "v2",
  // v7 (2026-04): pricing-only false-positive fix. Production audit
  // (Q3 disagreement query + visible-list screenshots, 2026-04-29)
  // found ~80% of pricing-tagged rows were misclassified — clear bugs
  // (shell escaping, compaction failure, MCP failures, model capacity,
  // notarization, /clear config) leaking into pricing through GitHub
  // issue-template metadata fields like
  //   ### What subscription do you have?
  //   Pro
  // and
  //   ### What plan are you on?
  //   Pro plan
  // which fired weight-3 phrases (`subscription`, `pro plan`) on
  // every Codex issue regardless of actual content. v7 ships four
  // targeted changes:
  //   - Removed `subscription` from CATEGORY_PATTERNS.pricing.
  //   - BODY_TEMPLATE_HEADER_RE strips metadata-header + short-answer
  //     blocks from body before phrase scoring (keyword-whitelisted,
  //     answer-line capped at 120 chars to protect prose).
  //   - Margin-0 abstain rule: when the top winner ties the runner-up,
  //     return "other" with confidence 0 instead of falling back to
  //     CATEGORY_PATTERNS insertion order (which deterministically
  //     favored `pricing` over `model-quality`).
  //   - SLUG_THRESHOLD.pricing = 4 (defense in depth).
  // No taxonomy / slug-list changes. See
  // scripts/033_topic_classifier_v7_bump.sql.
  category: "v7",
  impact: "v2",
  // competitor_mention shares the canonical lexicon (sentiment-lexicon.ts).
  // The sentiment v2 bump added words that are ALSO in NEGATORS (e.g.
  // "cannot"/"can't"), which changes scoreMentionSentiment's polarity
  // accounting on identical input — so mention rows written going forward
  // are no longer apples-to-apples with v1. Bump in lockstep to preserve
  // replay integrity. See scripts/011_algorithm_v2_bump.sql.
  competitor_mention: "v2",
  classification: "v1",
  // v3 (2026-05): classification-aware embedding input, tier-ordered
  // for a user-feedback corpus. The 2026-05-01 baseline snapshot
  // (singleton_rate 95.9%, semantic-key share 3.9%, title-fallback
  // share 96.1%) confirmed v2's structured-prefix approach was not
  // producing real semantic groupings — the embedding pipeline was
  // essentially producing one cluster per title.
  //
  // v3 changes the helper that produces input text. Instead of
  // bracketed [Type: …] [Error: …] tags prepended to title/body, v3
  // emits a tier-ordered structure that matches the user-feedback
  // corpus signal hierarchy locked in PR #193:
  //
  //   Tier 1 (primary):    Title, Summary, Topic, Category, Subcategory,
  //                        Tags (gated on confidence ≥ medium AND not
  //                        review-flagged)
  //   Tier 2 (secondary):  Severity, Reproducibility, Impact, Confidence
  //                        (gated on review-flagged only)
  //   Tier 3 (supportive): Environment (collapsed cli/os/shell/editor/
  //                        model), Error, Stack, Repro markers
  //
  // The collapse of the 6 fingerprint env fields into one
  // Environment: cli=… os=… line is the key change vs v2 — sparse
  // environment values were over-anchoring unrelated reports that
  // happened to share one runtime value (e.g., both running gpt-4o).
  //
  // v3 also requires the production embedding pipeline to FETCH more
  // upstream signals than v2: full classifications row, classification
  // reviews, complete bug_fingerprints. The v3 dispatch in
  // recomputeObservationEmbedding calls into v3-input-from-observation.ts
  // (which reuses Phase 2's helperInputFromRow) to assemble the input.
  //
  // v1/v2 rows remain in observation_embeddings for replay; v3 rows
  // get computed on demand by ensureEmbedding when the rebuild is run
  // after this bump. Phase 4 PR3 (backfill UI) provides the
  // operator-facing surface to trigger v3 generation across the
  // corpus. Stage 4a coverage MUST be pushed to ≥ 80% before that
  // backfill runs (currently 16%) — see Phase 4 §"Stage 4a / Stage 2
  // sequencing model" in CLASSIFICATION_EVOLUTION_PLAN.md.
  //
  // Algorithm-defining knobs are pinned in
  // V3_ALGORITHM_SIGNATURE inside lib/embeddings/classification-aware-input.ts;
  // structural properties (emit order, gating policy, collapse format)
  // are pinned by tests/classification-aware-input.test.ts. Changing
  // either bumps to v4.
  //
  // See scripts/035_observation_embedding_v3_bump.sql.
  observation_embedding: "v3",
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
  // v1 of Family Classification: heuristic-first per-cluster
  // interpretation (family_kind + needs_human_review) with optional
  // LLM-generated title/summary. Reads `mv_cluster_topic_metadata`
  // (added by 028); writes append-only rows to
  // `family_classifications` (added by 029). NOT a clustering or
  // labelling change — see docs/CLUSTERING_DESIGN.md §4.7.
  family_classification: "v1",
} as const

export type AlgorithmKind = keyof typeof CURRENT_VERSIONS

export const LEXICON_VERSION = "v1"
