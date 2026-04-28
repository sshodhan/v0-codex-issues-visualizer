// Pins the runtime algorithm-version registry (`CURRENT_VERSIONS` in
// lib/storage/algorithm-versions.ts) against the schema verifier's
// expected snapshot (`EXPECTED_MANIFEST.expectedCurrentAlgorithmVersions`
// in lib/schema/expected-manifest.ts).
//
// Why this matters: derivation rows are stamped with whatever
// `CURRENT_VERSIONS[kind]` is at write time, and the admin schema-verify
// page (which reads `algorithm_versions` from the live DB) compares
// against the manifest. If the two drift, the verifier surfaces a false-
// positive "unapplied migration" warning, or — worse — silently accepts
// a stale registry. This regression test fails the build the moment a
// developer bumps one and forgets the other.
//
// Specifically catches two known drifts:
// - semantic_cluster_label v1→v2 (PR #107)
// - category v3→v4 (Topic regex expansion/reweight) when runtime and
//   EXPECTED_MANIFEST are not bumped together.

import test from "node:test"
import assert from "node:assert/strict"

import { CURRENT_VERSIONS } from "../lib/storage/algorithm-versions.ts"
import { EXPECTED_MANIFEST } from "../lib/schema/expected-manifest.ts"

test("CURRENT_VERSIONS and EXPECTED_MANIFEST agree on every algorithm kind", () => {
  const runtimeKinds = Object.keys(CURRENT_VERSIONS).sort()
  const manifestKinds = Object.keys(
    EXPECTED_MANIFEST.expectedCurrentAlgorithmVersions,
  ).sort()
  assert.deepEqual(
    runtimeKinds,
    manifestKinds,
    "Algorithm-kind sets diverged between CURRENT_VERSIONS and EXPECTED_MANIFEST",
  )

  for (const kind of runtimeKinds) {
    const runtime = (CURRENT_VERSIONS as Record<string, string>)[kind]
    const manifest = (
      EXPECTED_MANIFEST.expectedCurrentAlgorithmVersions as Record<string, string>
    )[kind]
    assert.equal(
      runtime,
      manifest,
      `Algorithm version drift for ${kind}: CURRENT_VERSIONS=${runtime} but EXPECTED_MANIFEST=${manifest}`,
    )
  }
})
