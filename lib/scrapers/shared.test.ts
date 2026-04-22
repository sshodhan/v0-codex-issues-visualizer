import test from "node:test"
import assert from "node:assert/strict"

import { analyzeSentiment, calculateImpactScore } from "./shared.ts"

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
  // Row 15 from the eye test.
  assert.equal(
    analyzeSentiment("Unable to connect GitHub Auth to OpenAI Codex (Keeps Opening up the Configuration Page)").sentiment,
    "negative",
  )
  // Other v2 complaint markers.
  assert.equal(analyzeSentiment("the CLI is broken for me").sentiment, "negative")
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
