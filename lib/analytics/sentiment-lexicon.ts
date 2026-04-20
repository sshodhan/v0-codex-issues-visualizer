export const POSITIVE_WORDS: ReadonlySet<string> = new Set([
  "good", "great", "awesome", "excellent", "fantastic", "helpful", "useful",
  "love", "loved", "loving", "solid", "fine", "works", "working", "improved",
  "reliable", "fast", "faster", "accurate", "best", "better", "perfect",
  "wonderful", "impressive", "productive", "efficient", "amazing",
])

export const NEGATIVE_WORDS: ReadonlySet<string> = new Set([
  "bad", "awful", "terrible", "worst", "worse", "broken", "buggy", "hate",
  "slow", "slower", "unusable", "frustrating", "fails", "failing",
  "disappointing", "regression", "crash", "crashes", "crashing",
])

export const NEGATORS: ReadonlySet<string> = new Set([
  "not", "never", "no", "hardly", "scarcely", "without", "n't", "cannot", "cant",
])
