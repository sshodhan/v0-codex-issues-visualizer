// Canonical polarity lexicon used by every sentiment consumer in the app —
// both the ingest-time classifier (`lib/scrapers/shared.ts::analyzeSentiment`)
// and the mention-window classifier (`lib/analytics/competitive.ts`). The two
// callers previously had their own inline word lists that drifted apart; this
// module is the single source of truth so drift is no longer possible.
//
// Inclusion rule (refined in v2 after the Pattern-B eye test):
//
//   - Topic NOUNS stay out: "bug", "error", "issue", "problem", "fail",
//     "crash", "regression". They describe what a post is *about*, not how
//     the author feels. Treating them as polarity was P0-2. Those words are
//     still tracked at ingest time via `NEGATIVE_KEYWORD_PATTERNS` in
//     shared.ts and surfaced as `keyword_presence`.
//
//   - Polarity ADJECTIVES / distress VERBS are in: "broken", "buggy",
//     "unable", "stuck", "missing", "fails" (past-tense verb, distinct from
//     the topic noun "fail"), "painful", "clunky". These carry implicit
//     author-polarity in titles like "Unable to connect GitHub Auth …" that
//     v1 labeled neutral.
//
// This refinement is why `CURRENT_VERSIONS.sentiment` is "v2" — v1 rows stay
// in the DB for replay comparison.
//
// Multi-word phrases (e.g. "not working", "does not work",
// "keeps <V-ing>") are handled at the call site in shared.ts via regex.
export const POSITIVE_WORDS: ReadonlySet<string> = new Set([
  "good", "great", "awesome", "excellent", "fantastic", "helpful", "useful",
  "love", "loved", "loving", "solid", "fine", "improved",
  "reliable", "fast", "faster", "accurate", "best", "better", "perfect",
  "wonderful", "impressive", "productive", "efficient", "amazing",
  "revolutionary",
])

// "works" / "working" are deliberately excluded: they are factual status
// descriptors, not polarity ("my cursor is working" is neutral), and they
// collide with the multi-word pattern "not working" at the call site.

export const NEGATIVE_WORDS: ReadonlySet<string> = new Set([
  "bad", "awful", "terrible", "worst", "worse", "hate",
  "slow", "slower", "unusable", "frustrating", "disappointing",
  "useless", "annoying",
  // v2 complaint markers (eye-test Pattern B).
  "unable", "stuck", "broken", "missing", "fails", "failed",
  "can't", "cannot", "won't", "refuses", "buggy", "clunky", "painful",
])

export const NEGATORS: ReadonlySet<string> = new Set([
  "not", "never", "no", "hardly", "scarcely", "without", "n't", "cannot", "cant",
])
