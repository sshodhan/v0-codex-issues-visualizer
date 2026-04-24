import test from "node:test"
import assert from "node:assert/strict"

import { evidenceQuotesAreSubstrings, sanitizeEvidenceQuotes } from "../lib/classification/schema.ts"

test("sanitizeEvidenceQuotes keeps only exact substrings, trims, and dedupes", () => {
  const input = "alpha beta gamma delta"
  const sanitized = sanitizeEvidenceQuotes(
    {
      evidence_quotes: [
        "alpha beta",
        " alpha beta ",
        "gamma",
        "missing quote",
        42,
        "",
      ],
    },
    input,
  )

  assert.deepEqual(sanitized, ["alpha beta", "gamma"])
})

test("evidenceQuotesAreSubstrings fails on non-array and passes on all-substring array", () => {
  assert.equal(evidenceQuotesAreSubstrings({ evidence_quotes: "nope" }, "alpha"), false)
  assert.equal(evidenceQuotesAreSubstrings({ evidence_quotes: ["alpha", "beta"] }, "alpha beta"), true)
})

