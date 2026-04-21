import test from "node:test"
import assert from "node:assert/strict"

import { analyzeSentiment } from "./shared.ts"

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
