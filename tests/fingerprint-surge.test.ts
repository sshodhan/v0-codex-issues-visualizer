import test from "node:test"
import assert from "node:assert/strict"
import { selectTopFingerprintSurges } from "../lib/analytics/fingerprint-surge.ts"

test("fingerprint surge ranking uses delta desc and detects new_in_window", () => {
  const { surges, new_in_window } = selectTopFingerprintSurges([
    { error_code: "ENOENT", now_count: 18, prev_count: 2, delta: 16, sources: 3 },
    { error_code: "EACCES", now_count: 4, prev_count: 0, delta: 4, sources: 2 },
    { error_code: "ETIMEDOUT", now_count: 3, prev_count: 3, delta: 0, sources: 2 },
  ])

  assert.equal(surges.length, 2)
  assert.equal(surges[0].error_code, "ENOENT")
  assert.equal(surges[1].error_code, "EACCES")
  assert.deepEqual(new_in_window, [{ error_code: "EACCES", count: 4, sources: 2 }])
})
