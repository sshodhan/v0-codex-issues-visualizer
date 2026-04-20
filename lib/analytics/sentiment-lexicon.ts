// Canonical polarity lexicon used by every sentiment consumer in the app —
// both the ingest-time classifier (`lib/scrapers/shared.ts::analyzeSentiment`)
// and the mention-window classifier (`lib/analytics/competitive.ts`). The two
// callers previously had their own inline word lists that drifted apart; this
// module is the single source of truth so drift is no longer possible.
//
// Constraint: only true *polarity adjectives/verbs* belong here. Topic nouns
// ("bug", "error", "issue", "problem", "fail") are deliberately excluded —
// every post in the "Bug" category contains those words regardless of tone,
// and counting them as negative is the P0-2 contamination bug. Multi-word
// phrases (e.g. "not working") are handled at the call site via regex.
export const POSITIVE_WORDS: ReadonlySet<string> = new Set([
  "good", "great", "awesome", "excellent", "fantastic", "helpful", "useful",
  "love", "loved", "loving", "solid", "fine", "improved",
  "reliable", "fast", "faster", "accurate", "best", "better", "perfect",
  "wonderful", "impressive", "productive", "efficient", "amazing",
  "revolutionary",
])

// "works" / "working" are deliberately excluded: they are factual status
// descriptors, not polarity ("my cursor is working" is neutral), and they
// collide with the multi-word pattern "not working" at the call site. Leaving
// them out keeps the multi-word negation logic simple and avoids false
// positives on neutral status reports.

export const NEGATIVE_WORDS: ReadonlySet<string> = new Set([
  "bad", "awful", "terrible", "worst", "worse", "broken", "buggy", "hate",
  "slow", "slower", "unusable", "frustrating", "fails", "failing",
  "disappointing", "regression", "crash", "crashes", "crashing",
  "useless", "annoying",
])

export const NEGATORS: ReadonlySet<string> = new Set([
  "not", "never", "no", "hardly", "scarcely", "without", "n't", "cannot", "cant",
])
