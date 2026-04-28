import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const src = readFileSync(new URL("../lib/scrapers/index.ts", import.meta.url), "utf8")

test("runScraper batches semantic candidates before clustering (no per-item clustering)", () => {
  const runScraperStart = src.indexOf("export async function runScraper")
  assert.ok(runScraperStart >= 0, "runScraper function should exist")
  const runScraperBody = src.slice(runScraperStart)

  assert.match(
    runScraperBody,
    /semanticCandidates\.push\(persisted\.semanticObservation\)/,
    "runScraper should accumulate semantic candidates from each new observation",
  )
  assert.match(
    runScraperBody,
    /runPostLoopSemanticClustering\(supabase,\s*semanticCandidates,\s*`runScraper:\$\{slug\}`\)/,
    "runScraper should invoke post-loop batched clustering with semanticCandidates",
  )
  assert.doesNotMatch(
    runScraperBody,
    /runSemanticClusteringForBatch\(supabase,\s*\[\s*\{/,
    "runScraper must not regress to per-item semantic clustering calls",
  )
})

test("post-loop semantic helper keeps clustering failure contained", () => {
  assert.match(
    src,
    /export async function runPostLoopSemanticClustering[\s\S]*?try \{[\s\S]*?runBatch\([\s\S]*?\} catch \(error\) \{[\s\S]*?console\.error/s,
    "post-loop helper should catch clustering errors and log them",
  )
})
