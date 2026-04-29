import test from "node:test"
import assert from "node:assert/strict"

import { canonicalizeUrl } from "./url.ts"

test("canonicalizeUrl returns null for empty/nullish input", () => {
  assert.equal(canonicalizeUrl(null), null)
  assert.equal(canonicalizeUrl(undefined), null)
  assert.equal(canonicalizeUrl(""), null)
  assert.equal(canonicalizeUrl("   "), null)
})

test("canonicalizeUrl collapses the www. host prefix (the symptom from the bug report)", () => {
  // The exact pair from the issue description: same article, two HN
  // submissions, URLs differ only by the www. prefix.
  const a = canonicalizeUrl("https://www.highcaffeinecontent.com/blog/codex")
  const b = canonicalizeUrl("https://highcaffeinecontent.com/blog/codex")
  assert.equal(a, b)
  assert.equal(a, "https://highcaffeinecontent.com/blog/codex")
})

test("canonicalizeUrl lowercases the hostname but preserves path case", () => {
  // Hostnames are case-insensitive in DNS; paths are not (per RFC 3986 the
  // path is case-sensitive even though many servers normalize it). We only
  // lowercase the host so distinct paths stay distinct.
  assert.equal(
    canonicalizeUrl("https://Example.COM/MyPath"),
    "https://example.com/MyPath",
  )
})

test("canonicalizeUrl strips a trailing slash but keeps the root /", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/foo/"),
    canonicalizeUrl("https://example.com/foo"),
  )
  // A bare host should still serialize with the root /.
  assert.equal(canonicalizeUrl("https://example.com"), "https://example.com/")
  assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/")
})

test("canonicalizeUrl strips known tracking params but keeps functional params", () => {
  const tracked =
    "https://example.com/post?utm_source=hn&utm_campaign=launch&id=42&page=2"
  const clean = "https://example.com/post?id=42&page=2"
  assert.equal(canonicalizeUrl(tracked), clean)
})

test("canonicalizeUrl strips the full set of tracking params", () => {
  // Ensures gclid, fbclid, mc_*, ref, source are all classified as tracking.
  const tracked =
    "https://example.com/x?gclid=abc&fbclid=def&mc_eid=g&ref=newsletter&source=tw&id=1"
  assert.equal(canonicalizeUrl(tracked), "https://example.com/x?id=1")
})

test("canonicalizeUrl sorts query params so order does not break equality", () => {
  const a = canonicalizeUrl("https://example.com/x?b=2&a=1")
  const b = canonicalizeUrl("https://example.com/x?a=1&b=2")
  assert.equal(a, b)
})

test("canonicalizeUrl drops the fragment (servers never see #anchor)", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/post#comments"),
    "https://example.com/post",
  )
})

test("canonicalizeUrl returns the original string when parsing fails", () => {
  // Invalid URL — the helper falls through to the raw string rather than
  // throwing so the scraper insert path keeps working on weird inputs.
  assert.equal(canonicalizeUrl("not a url"), "not a url")
})

test("canonicalizeUrl preserves Hacker News story permalinks unchanged", () => {
  // HN's fallback URL pattern (used when a story has no outbound link) must
  // round-trip stably so two re-scrapes of the same self-post collapse.
  const url = "https://news.ycombinator.com/item?id=47388026"
  assert.equal(canonicalizeUrl(url), url)
})

test("canonicalizeUrl normalizes protocol case", () => {
  assert.equal(
    canonicalizeUrl("HTTPS://example.com/x"),
    "https://example.com/x",
  )
})
