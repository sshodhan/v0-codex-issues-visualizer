// Canonical polarity lexicon used by every sentiment consumer in the app —
// both the ingest-time classifier (`lib/scrapers/shared.ts::analyzeSentiment`)
// and the mention-window classifier (`lib/analytics/competitive.ts`). The two
// callers previously had their own inline word lists that drifted apart; this
// module is the single source of truth so drift is no longer possible.
//
// Constraint: only true *polarity adjectives/verbs expressing opinion* belong
// here. Topic nouns and problem-describing verbs ("bug", "error", "issue",
// "problem", "fail", "crash", "broken", "regression", "buggy") are
// deliberately excluded — they describe what a post is *about*, not how the
// author feels. Treating them as polarity was P0-2. Those words are still
// tracked at ingest time via `NEGATIVE_KEYWORD_PATTERNS` in shared.ts and
// surfaced as `keyword_presence` for urgency-layer consumption.
//
// Multi-word phrases (e.g. "not working") are handled at the call site via
// regex.
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
])

export const NEGATORS: ReadonlySet<string> = new Set([
  "not", "never", "no", "hardly", "scarcely", "without", "n't", "cannot", "cant",
])
