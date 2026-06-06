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
//   1. The strip must be imported and mounted in app/page.tsx, inside <main>.
//   2. It is scoped to the Dashboard tab — mounted inside
//      <TabsContent value="dashboard"> (under the Hot themes area), below the
//      stats-loading branch — rather than as a global header above the tabs.
//   3. It must be passed the prerequisite + stats-error signals (not just
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

test("placement: strip is mounted inside the Dashboard tab content", async () => {
  const src = await readSource("app/page.tsx")
  const stripIdx = src.indexOf("<PipelineFreshnessStrip")
  const dashboardTabIdx = src.indexOf('<TabsContent value="dashboard"')
  // The next tab marks the end of the dashboard tab's content block.
  const nextTabIdx = src.indexOf('<TabsContent value="v3"')
  assert.ok(stripIdx > -1, "strip not found")
  assert.ok(
    dashboardTabIdx > -1 && nextTabIdx > dashboardTabIdx,
    "dashboard tab block not found",
  )
  assert.ok(
    dashboardTabIdx < stripIdx && stripIdx < nextTabIdx,
    "strip must be mounted inside the Dashboard TabsContent (dashboard-scoped, not a global header)",
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

test("placement: strip is scoped inside the Tabs block, not a global header above the tabs", async () => {
  const src = await readSource("app/page.tsx")
  // The strip lives inside the <Tabs> block (dashboard-scoped), not as a
  // shared header rendered above the tab branching for every tab.
  const tabsIdx = src.indexOf("<Tabs ")
  const stripIdx = src.indexOf("<PipelineFreshnessStrip")
  const mainCloseIdx = src.lastIndexOf("</main>")
  assert.ok(tabsIdx > -1 && stripIdx > -1, "could not locate <Tabs> and the strip")
  assert.ok(
    tabsIdx < stripIdx && stripIdx < mainCloseIdx,
    "strip must live inside the <Tabs> block (tab-scoped), not as a header above all tabs",
  )
})

test("placement: strip renders below the stats-loading branch (loaded-dashboard view)", async () => {
  const src = await readSource("app/page.tsx")
  const stripIdx = src.indexOf("<PipelineFreshnessStrip")
  const branchingIdx = src.indexOf("{statsLoading ?")
  assert.ok(stripIdx > -1 && branchingIdx > -1, "strip or statsLoading branch not found")
  assert.ok(
    branchingIdx < stripIdx,
    "strip is mounted in the loaded-stats Dashboard view, after the statsLoading branch",
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
