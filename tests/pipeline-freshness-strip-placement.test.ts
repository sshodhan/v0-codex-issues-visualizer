import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

// Structural integration test for the pipeline-freshness strip.
//
// The project's Node-based test runner (--experimental-strip-types) cannot
// execute .tsx files or render React components. Instead, this file asserts
// the placement contract at the source level:
//
//   1. The strip must be imported and mounted in app/page.tsx.
//   2. It must live ABOVE the loading/error/empty branching inside <main>,
//      so "no issues" vs "pipeline not caught up" is visible in every state.
//   3. It must be reachable from the triage context (Classifications tab).
//      Since all tabs share the same <main>, a single mount above the tab
//      branching satisfies this — the test enforces that invariant.
//   4. It must be passed the prerequisite + stats-error signals (not just
//      a single status string).
//
// Failure messages below point the reader at the exact property or pattern
// that went missing so regressions can be root-caused quickly.

const REPO_ROOT = process.cwd()

async function readSource(relativePath: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relativePath), "utf8")
}

test("placement: app/page.tsx imports PipelineFreshnessStrip", async () => {
  const src = await readSource("app/page.tsx")
  assert.match(
    src,
    /import\s*\{\s*PipelineFreshnessStrip\s*\}\s*from\s*["']@\/components\/dashboard\/pipeline-freshness-strip["']/,
    "PipelineFreshnessStrip must be imported by the dashboard page",
  )
})

test("placement: PipelineFreshnessStrip is mounted inside <main>", async () => {
  const src = await readSource("app/page.tsx")
  const mainOpenIdx = src.indexOf("<main")
  const mainCloseIdx = src.lastIndexOf("</main>")
  assert.ok(mainOpenIdx > -1 && mainCloseIdx > mainOpenIdx, "could not locate <main> block")
  const mainBody = src.slice(mainOpenIdx, mainCloseIdx)
  assert.ok(
    mainBody.includes("<PipelineFreshnessStrip"),
    "PipelineFreshnessStrip must be rendered inside <main> so it persists across tab contexts",
  )
})

test("placement: strip is rendered ABOVE the loading/error/empty branching", async () => {
  const src = await readSource("app/page.tsx")
  const stripIdx = src.indexOf("<PipelineFreshnessStrip")
  const branchingIdx = src.indexOf("{statsLoading ?")
  assert.ok(stripIdx > -1, "strip not found")
  assert.ok(branchingIdx > -1, "expected statsLoading branch not found")
  assert.ok(
    stripIdx < branchingIdx,
    "strip must precede the loading/error/empty branching so it is visible in every state (not gated by stats being loaded)",
  )
})

test("placement: strip is NOT wrapped in a conditional that hides it on empty data", async () => {
  const src = await readSource("app/page.tsx")
  // Check the 200 chars before <PipelineFreshnessStrip don't contain
  // a conditional like `totalIssues === 0 &&` or `stats && `.
  const stripIdx = src.indexOf("<PipelineFreshnessStrip")
  assert.ok(stripIdx > -1)
  const preamble = src.slice(Math.max(0, stripIdx - 200), stripIdx)
  assert.doesNotMatch(
    preamble,
    /totalIssues\s*===\s*0\s*&&/,
    "strip must not be gated by totalIssues === 0",
  )
  assert.doesNotMatch(
    preamble,
    /!stats\s*&&/,
    "strip must not be gated by the stats object being loaded",
  )
})

test("placement: strip receives prereq, pendingReviewCount, statsError, and windowLabel", async () => {
  const src = await readSource("app/page.tsx")
  const stripIdx = src.indexOf("<PipelineFreshnessStrip")
  const propsChunk = src.slice(stripIdx, src.indexOf("/>", stripIdx) + 2)
  for (const prop of ["prereq=", "pendingReviewCount=", "statsError=", "windowLabel="]) {
    assert.ok(
      propsChunk.includes(prop),
      `expected PipelineFreshnessStrip to receive \`${prop}\` — got:\n${propsChunk}`,
    )
  }
})

test("placement: triage context (Classifications tab) inherits the same strip via shared <main>", async () => {
  const src = await readSource("app/page.tsx")
  // All three tabs live inside the same Tabs block, which itself sits
  // inside the <main> that hosts the strip. Verify the structural chain:
  //   <main> > <PipelineFreshnessStrip> > … > <TabsContent value="classifications">
  const mainOpenIdx = src.indexOf("<main")
  const stripIdx = src.indexOf("<PipelineFreshnessStrip")
  const classificationsTabIdx = src.indexOf('<TabsContent value="classifications"')
  const mainCloseIdx = src.lastIndexOf("</main>")
  assert.ok(
    mainOpenIdx < stripIdx &&
      stripIdx < classificationsTabIdx &&
      classificationsTabIdx < mainCloseIdx,
    "strip must appear above the classifications tab inside the shared <main> scope",
  )
})

test("placement: dashboard tab has access to the strip (strip precedes TabsContent dashboard)", async () => {
  const src = await readSource("app/page.tsx")
  const stripIdx = src.indexOf("<PipelineFreshnessStrip")
  const dashboardTabIdx = src.indexOf('<TabsContent value="dashboard"')
  assert.ok(stripIdx > -1 && dashboardTabIdx > -1)
  assert.ok(
    stripIdx < dashboardTabIdx,
    "strip must appear above the dashboard tab",
  )
})

test("view-model plumbing: app/page.tsx derives pipelinePrereq with explicit loading vs null", async () => {
  const src = await readSource("app/page.tsx")
  // The key invariant: undefined = loading, null = server returned no
  // prereqs. Collapsing to a single "falsy" check would hide the unknown
  // state behind a healthy-looking default.
  assert.match(
    src,
    /pipelinePrereq\s*=\s*classificationStatsLoading\s*\?\s*undefined/,
    "pipelinePrereq must keep loading separate from null",
  )
  assert.match(
    src,
    /classificationStats\?\.\s*prerequisites\s*\?\?\s*null/,
    "pipelinePrereq must fall through to null when classificationStats.prerequisites is missing",
  )
})

test("view-model plumbing: pendingReviewCount is undefined while stats load (never 0 by default)", async () => {
  const src = await readSource("app/page.tsx")
  assert.match(
    src,
    /pipelineReviewCount\s*=\s*classificationStatsLoading\s*\?\s*undefined/,
    "pipelineReviewCount must be undefined while loading so the strip shows 'Unavailable' instead of a silent 0",
  )
})

test("strip source: renderer delegates to derivePipelineFreshness (thin-renderer contract)", async () => {
  const src = await readSource("components/dashboard/pipeline-freshness-strip.tsx")
  assert.match(
    src,
    /import\s*\{[^}]*derivePipelineFreshness[^}]*\}\s*from\s*["']@\/lib\/dashboard\/pipeline-freshness["']/,
    "strip must import derivePipelineFreshness so state logic stays out of JSX",
  )
  assert.match(
    src,
    /const\s+vm\s*=\s*derivePipelineFreshness\s*\(/,
    "strip must invoke derivePipelineFreshness to build its view model",
  )
})

test("strip source: missing metric values render as 'Unavailable' (no healthy-looking fallback)", async () => {
  const src = await readSource("components/dashboard/pipeline-freshness-strip.tsx")
  assert.match(
    src,
    /metric\.value\s*\?\?\s*["']Unavailable["']/,
    "MetricCell must render 'Unavailable' for null values; defaulting to 0 or '—' silently would hide unknown states",
  )
})

test("strip source: data-state and data-reason attributes are exposed for integration assertions", async () => {
  const src = await readSource("components/dashboard/pipeline-freshness-strip.tsx")
  assert.match(src, /data-state=\{vm\.state\}/)
  assert.match(src, /data-reason=\{vm\.reason\}/)
})

test("strip source: aria-live='polite' is set so screen readers announce state updates", async () => {
  const src = await readSource("components/dashboard/pipeline-freshness-strip.tsx")
  assert.match(src, /aria-live=["']polite["']/)
})
