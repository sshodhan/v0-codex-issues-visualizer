import test from "node:test"
import assert from "node:assert/strict"

import { analyzeSentiment, calculateImpactScore } from "./shared.ts"
import { NEGATIVE_WORDS, POSITIVE_WORDS } from "../analytics/sentiment-lexicon.ts"

test("analyzeSentiment tokenizes (no substring matches inside unrelated identifiers)", () => {
  // Before P0-2 was closed, "debug" would have substring-matched "bug" in the
  // old negative list. With the tokenized lexicon-driven approach, neither
  // "debug" nor "debugger" contains any polarity token.
  const { sentiment, score } = analyzeSentiment("The debugger attached to the process.")
  assert.equal(sentiment, "neutral")
  assert.equal(score, 0)
})

test("analyzeSentiment no longer counts topic nouns as negative (P0-2 regression)", () => {
  // Topic nouns ("bug", "error", "issue", "problem", "fail") used to live in
  // the inline negative list, pre-loading every bug-report with negative
  // sentiment regardless of tone. After unification they are absent from the
  // canonical lexicon, so a dry bug-report signal is genuinely neutral.
  // Note: "crash" remains a polarity verb in the lexicon by design — a
  // runtime crash is a legitimate distress signal. This test uses pure topic
  // nouns to lock the fix without overclaiming.
  const { sentiment } = analyzeSentiment(
    "Bug report: error in the response, stack trace attached for this issue and problem.",
  )
  assert.equal(sentiment, "neutral")
})

test("analyzeSentiment still detects real polarity words", () => {
  assert.equal(analyzeSentiment("this tool is great and helpful").sentiment, "positive")
  assert.equal(analyzeSentiment("this is awful and unusable").sentiment, "negative")
})

test("analyzeSentiment recognizes the 'doesn't work' / 'not working' multi-word negatives", () => {
  assert.equal(analyzeSentiment("the command doesn't work anymore").sentiment, "negative")
  assert.equal(analyzeSentiment("this feature is not working at all").sentiment, "negative")
})

// v2: eye-test Pattern B — implicit frustration via lexicon expansion.
test("analyzeSentiment v2 catches implicit frustration markers", () => {
  // Row 15 from the eye test (combines "unable" + "keeps opening").
  assert.equal(
    analyzeSentiment("Unable to connect GitHub Auth to OpenAI Codex (Keeps Opening up the Configuration Page)").sentiment,
    "negative",
  )
  // Other v2 polarity additions. Note: "broken" is deliberately NOT here —
  // it stays in NEGATIVE_KEYWORD_PATTERNS (keyword_presence) rather than
  // NEGATIVE_WORDS, so "the fix is broken" / "the broken symlink" reads
  // neutral at polarity level, positive/negative at topic level.
  assert.equal(analyzeSentiment("I'm stuck trying to configure the provider").sentiment, "negative")
  assert.equal(analyzeSentiment("this is missing the --resume flag").sentiment, "negative")
  assert.equal(analyzeSentiment("can't get the approval prompt to stop").sentiment, "negative")
})

// v2: eye-test Pattern B — multi-word complaint patterns.
test("analyzeSentiment v2 recognizes 'does not work' and 'keeps <V-ing>'", () => {
  assert.equal(analyzeSentiment("this command does not work on Windows").sentiment, "negative")
  assert.equal(analyzeSentiment("the tool keeps prompting for approval").sentiment, "negative")
  assert.equal(analyzeSentiment("the config page keeps opening in a loop").sentiment, "negative")
})

// v2: eye-test Pattern A — source-authority weighting.
test("calculateImpactScore v2: first-party GitHub issue outranks viral Show-HN announcement", () => {
  // The Pattern A anchor: a 0-upvote / 4-comment open bug on openai/codex vs.
  // a 516-upvote / 289-comment Show HN announcement.
  const firstPartyBug = calculateImpactScore(0, 4, "negative", "github")
  const viralAnnouncement = calculateImpactScore(516, 289, "neutral", "hackernews")
  assert.ok(
    firstPartyBug > viralAnnouncement,
    `expected github-bug (${firstPartyBug}) > hn-announcement (${viralAnnouncement})`,
  )
})

test("calculateImpactScore v2: authority multiplier orders sources correctly at identical engagement", () => {
  // Same engagement, same sentiment — only the source slug varies. Exercise
  // the ordering: github > github-discussions > stackoverflow/openai-community
  // > reddit/hackernews.
  const gh = calculateImpactScore(40, 30, "neutral", "github")
  const ghDisc = calculateImpactScore(40, 30, "neutral", "github-discussions")
  const so = calculateImpactScore(40, 30, "neutral", "stackoverflow")
  const oai = calculateImpactScore(40, 30, "neutral", "openai-community")
  const reddit = calculateImpactScore(40, 30, "neutral", "reddit")
  const hn = calculateImpactScore(40, 30, "neutral", "hackernews")

  assert.ok(gh >= ghDisc, `github (${gh}) should >= github-discussions (${ghDisc})`)
  assert.ok(ghDisc >= so, `github-discussions (${ghDisc}) should >= stackoverflow (${so})`)
  assert.equal(so, oai, "stackoverflow and openai-community share the 1.0× baseline")
  assert.ok(so >= reddit, `stackoverflow (${so}) should >= reddit (${reddit})`)
  assert.equal(reddit, hn, "reddit and hackernews share the 0.7× announcement weight")
})

test("calculateImpactScore v2: omitted sourceSlug preserves v1 back-compat behavior", () => {
  // Back-compat: old 3-arg callers (including the 5 existing assertions in
  // tests/scoring-pipeline.test.ts) multiply by 1.0× authority.
  const v1Style = calculateImpactScore(30, 12, "neutral")
  const v2Unknown = calculateImpactScore(30, 12, "neutral", "unknown-source")
  const v2Baseline = calculateImpactScore(30, 12, "neutral", "stackoverflow")
  assert.equal(v1Style, v2Unknown)
  assert.equal(v1Style, v2Baseline)
})

test("calculateImpactScore v2: negative-sentiment 1.5× boost still stacks with authority (PR #11 preserved)", () => {
  const neutralGh = calculateImpactScore(40, 30, "neutral", "github")
  const negativeGh = calculateImpactScore(40, 30, "negative", "github")
  assert.ok(
    negativeGh >= neutralGh,
    `negative github (${negativeGh}) should >= neutral github (${neutralGh}); PR #11 sentiment boost must survive v2`,
  )
})

// Post-review fixes (second commit on the v2 branch).

test("analyzeSentiment normalizes the curly apostrophe (U+2019) before tokenizing", () => {
  // Pre-merge senior-engineer review caught that lexicon entries like
  // "can't"/"won't" and the multi-word "doesn't work" regex would never
  // fire on realistic web text (iOS autocorrect, most copy-paste) because
  // the tokenizer regex /[a-z']+/g only matches the ASCII apostrophe.
  // Fix: normalize ’ → ' at the top of analyzeSentiment.
  assert.equal(analyzeSentiment("I can’t get this to work at all").sentiment, "negative")
  assert.equal(analyzeSentiment("it doesn’t work on macOS").sentiment, "negative")
  assert.equal(analyzeSentiment("the tool won’t stop prompting").sentiment, "negative")
})

test("analyzeSentiment returns keyword_presence independent of polarity", () => {
  // Lock the P0-2 invariant: topic/status nouns contribute to
  // keyword_presence but NOT to polarity. The enrich pass threads this
  // through into sentiment_scores.keyword_presence (fixed in the same
  // commit — v1 hardcoded 0 there).
  const r = analyzeSentiment("bug report: crash and regression in error handling")
  assert.equal(r.sentiment, "neutral", "topic nouns must not drive polarity")
  assert.ok(r.keyword_presence >= 3, "bug + crash + regression + error should all hit keyword_presence")
})

test("sentiment lexicon keeps topic/status nouns OUT of NEGATIVE_WORDS", () => {
  // Prevents future drift — if someone adds "bug" or "broken" back to
  // NEGATIVE_WORDS, the polarity/topic split is silently broken and
  // every bug-report gets wrongly stamped negative. This test locks the
  // contract.
  const mustBeAbsent = [
    "bug", "bugs", "error", "errors", "crash", "crashes",
    "fail", "failure", "broken", "fails", "failed",
    "issue", "issues", "problem", "problems", "regression", "regressions",
  ]
  for (const word of mustBeAbsent) {
    assert.ok(
      !NEGATIVE_WORDS.has(word),
      `"${word}" must be absent from NEGATIVE_WORDS (tracked via NEGATIVE_KEYWORD_PATTERNS → keyword_presence instead)`,
    )
  }
})

test("sentiment lexicon: polarity verbs of distress are IN NEGATIVE_WORDS (v2)", () => {
  // Companion to the above — the v2 additions must all be present so a
  // future refactor doesn't silently drop them.
  const mustBePresent = ["unable", "stuck", "missing", "can't", "cannot", "won't", "buggy", "clunky", "painful"]
  for (const word of mustBePresent) {
    assert.ok(
      NEGATIVE_WORDS.has(word),
      `"${word}" must be in NEGATIVE_WORDS (v2 eye-test Pattern B)`,
    )
  }
})

test("sentiment lexicon: positive and negative sets are disjoint", () => {
  // Sanity: a token should never simultaneously add +1 and −1 to the score.
  for (const word of POSITIVE_WORDS) {
    assert.ok(!NEGATIVE_WORDS.has(word), `"${word}" is in both POSITIVE_WORDS and NEGATIVE_WORDS`)
  }
})

test("calculateImpactScore v2: PR #11 boost holds at every authority level", () => {
  // Earlier test covered only github. Lock the invariant for every
  // authority slug so a future tuning that, say, clamps too aggressively
  // can't silently kill the negative boost on reddit/hn.
  const slugs: Array<string | undefined> = [
    "github", "github-discussions", "stackoverflow", "openai-community",
    "reddit", "hackernews", undefined,
  ]
  for (const slug of slugs) {
    const neutral = calculateImpactScore(40, 30, "neutral", slug)
    const negative = calculateImpactScore(40, 30, "negative", slug)
    assert.ok(
      negative >= neutral,
      `PR #11 boost violated at authority="${slug ?? "(unknown)"}": neutral=${neutral} vs negative=${negative}`,
    )
  }
})
