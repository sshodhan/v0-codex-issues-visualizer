import test from "node:test"
import assert from "node:assert/strict"

import { normalizeError } from "../lib/error-tracking/server-logger.ts"

// The classify-backfill admin GET was returning `"[object Object]"` as
// the logged error message, which made production failures un-debuggable.
// These tests pin the invariant that every path through normalizeError
// emits a human-readable message — even for the Supabase PostgrestError
// shape that was previously stringified as "[object Object]".

test("normalizeError preserves Error.message + stack", () => {
  const err = new Error("boom")
  const normalized = normalizeError(err)
  assert.equal(normalized.message, "boom")
  assert.equal(normalized.errorName, "Error")
  assert.ok(normalized.stack?.includes("boom"))
})

test("normalizeError preserves code/details/hint from Error subclasses", () => {
  // Some libraries attach PostgrestError-like fields to Error subclasses.
  // Those must flow into the log payload so operators can see them.
  const err = new Error("query failed") as Error & {
    code?: string
    details?: string
    hint?: string
  }
  err.code = "PGRST301"
  err.details = "row too wide"
  err.hint = "use explicit columns"
  const normalized = normalizeError(err)
  assert.equal(normalized.code, "PGRST301")
  assert.equal(normalized.details, "row too wide")
  assert.equal(normalized.hint, "use explicit columns")
})

test("normalizeError extracts message from plain-object Supabase errors", () => {
  // Supabase returns a plain object with {message, details, hint, code} —
  // this is the case that produced "[object Object]" in prod. The fix
  // must surface the real message so the log is actionable.
  const supabaseError = {
    message: "fetch failed",
    code: "ECONNRESET",
    details: "connection reset by peer",
    hint: null,
  }
  const normalized = normalizeError(supabaseError)
  assert.equal(normalized.message, "fetch failed")
  assert.equal(normalized.code, "ECONNRESET")
  assert.equal(normalized.details, "connection reset by peer")
  assert.equal(normalized.hint, undefined) // null hints are dropped
  assert.equal(normalized.errorName, "NonError")
})

test("normalizeError falls back to JSON-serialization for shapeless objects", () => {
  // An object without a `message` field still yields something better
  // than "[object Object]" — the full serialized shape is a valid
  // breadcrumb for operators piecing together what happened.
  const weird = { foo: 42, nested: { bar: "baz" } }
  const normalized = normalizeError(weird)
  assert.ok(
    normalized.message.includes("42"),
    `expected serialized form to mention the object, got ${normalized.message}`,
  )
  assert.doesNotMatch(normalized.message, /\[object Object\]/)
})

test("normalizeError caps JSON-serialized messages at 500 chars", () => {
  // Defense against a huge error object crowding the log stream.
  const huge = { message: undefined, data: "x".repeat(10_000) }
  const normalized = normalizeError(huge)
  assert.ok(normalized.message.length <= 500, "message must be bounded")
})

test("normalizeError handles strings", () => {
  const normalized = normalizeError("something broke")
  assert.equal(normalized.message, "something broke")
  assert.equal(normalized.errorName, "NonError")
})

test("normalizeError handles numbers, booleans, null, undefined", () => {
  assert.equal(normalizeError(42).message, "42")
  assert.equal(normalizeError(true).message, "true")
  assert.equal(normalizeError(null).message, "null")
  assert.equal(normalizeError(undefined).message, "undefined")
})

test("normalizeError handles unserializable circular objects without throwing", () => {
  // Regression guard: if the caller passes a self-referential object
  // (e.g. some JS runtime errors), JSON.stringify throws. normalizeError
  // must catch that and still produce a log-safe payload.
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const normalized = normalizeError(circular)
  assert.ok(normalized.message.length > 0)
  assert.doesNotMatch(normalized.message, /\[object Object\]/)
})

test("normalizeError returns empty-message fallback for Error with no message", () => {
  // Some Error subclasses don't set .message. Don't emit a literal
  // empty string — that's as useless as "[object Object]" was.
  const err = new Error("")
  const normalized = normalizeError(err)
  assert.equal(normalized.message, "(no message)")
})

test("normalizeError returns (no message) for plain-object errors with empty message and no other fields", () => {
  // PostgREST sometimes bubbles transient failures up as
  // `{ message: "" }` with nothing else populated. The previous
  // implementation JSON-stringified the object and emitted the literal
  // `{"message":""}` — which carries the same amount of information as
  // "[object Object]" did. Surface "(no message)" instead so callers
  // know there's nothing to dig into and rely on surrounding context.
  const empty = { message: "" }
  const normalized = normalizeError(empty)
  assert.equal(normalized.message, "(no message)")
  assert.equal(normalized.errorName, "NonError")
})

test("normalizeError returns (no message) for fully empty plain objects", () => {
  const normalized = normalizeError({})
  assert.equal(normalized.message, "(no message)")
})

test("normalizeError preserves real fields when message is empty but other keys carry info", () => {
  // If `message` is empty but `code`/`details` are populated, surface
  // those — they're the actionable bit. The serialized fallback shows
  // the operator the full shape so they can correlate.
  const partial = { message: "", code: "PGRST301", details: "abort" }
  const normalized = normalizeError(partial)
  assert.equal(normalized.code, "PGRST301")
  assert.equal(normalized.details, "abort")
  assert.ok(
    normalized.message.includes("PGRST301") ||
      normalized.message.includes("abort"),
    `expected serialized fallback to mention populated fields, got ${normalized.message}`,
  )
})
