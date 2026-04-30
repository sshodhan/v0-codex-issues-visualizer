import test from "node:test"
import assert from "node:assert/strict"
import {
  buildStoryTimeline,
  captionForMode,
  modeToCloudParam,
  parseCloudParam,
} from "../lib/dashboard/story-timeline.ts"
import type { Issue } from "../hooks/use-dashboard-data.ts"

const baseIssue: Issue = {
  id: "obs-1",
  title: "Issue",
  content: "",
  url: "https://example.com",
  author: "a",
  sentiment: "neutral",
  sentiment_score: 0,
  impact_score: 5,
  frequency_count: 1,
  upvotes: 0,
  comments_count: 0,
  published_at: "2026-04-29T00:00:00.000Z",
  source: { name: "GitHub", slug: "github", icon: "" },
  category: { name: "Bug", slug: "bug", color: "#f00" },
  cluster_id: "c1",
}

test("story timeline: cluster_family uses family title then pending fallback", () => {
  const clusterLookup = new Map([["c1", { id: "c1", label: "Bug cluster" }]])
  const named = buildStoryTimeline([baseIssue], clusterLookup, new Map([["c1", { id: "c1", family_title: "TTY crash" }]]), "cluster_family")
  assert.equal(named[0]?.familyName, "TTY crash")

  const missing = buildStoryTimeline([baseIssue], clusterLookup, new Map(), "cluster_family")
  assert.equal(missing[0]?.familyName, "Pending family classification")
})

test("story timeline: cluster_label uses label then unlabelled fallback", () => {
  const clusterLookup = new Map([["c1", { id: "c1", label: "Bug cluster" }]])
  const labelled = buildStoryTimeline([baseIssue], clusterLookup, new Map(), "cluster_label")
  assert.equal(labelled[0]?.familyName, "Bug cluster")

  const unlabelled = buildStoryTimeline([baseIssue], new Map(), new Map(), "cluster_label")
  assert.equal(unlabelled[0]?.familyName, "Unlabelled cluster")
})

test("story timeline: cluster mode uses family → label → pending ladder", () => {
  const clusterLookup = new Map([["c1", { id: "c1", label: "Bug cluster" }]])
  const withFamily = buildStoryTimeline([baseIssue], clusterLookup, new Map([["c1", { id: "c1", family_title: "TTY crash" }]]), "cluster")
  assert.equal(withFamily[0]?.familyName, "TTY crash")

  const withLabelOnly = buildStoryTimeline([baseIssue], clusterLookup, new Map(), "cluster")
  assert.equal(withLabelOnly[0]?.familyName, "Bug cluster")

  const none = buildStoryTimeline([baseIssue], new Map(), new Map(), "cluster")
  assert.equal(none[0]?.familyName, "Pending family classification")
})

test("story timeline: topic mode preserves the legacy family fallback (label → unlabelled)", () => {
  const clusterLookup = new Map([["c1", { id: "c1", label: "Bug cluster" }]])
  const labelled = buildStoryTimeline([baseIssue], clusterLookup, new Map(), "topic")
  // Topic mode colors by category, but familyName still uses the legacy ladder.
  assert.equal(labelled[0]?.familyName, "Bug cluster")
  assert.equal(labelled[0]?.categoryName, "Bug")

  const unlabelled = buildStoryTimeline([baseIssue], new Map(), new Map(), "topic")
  assert.equal(unlabelled[0]?.familyName, "Unlabelled Family")
})

test("story timeline: issues without a cluster_id always render as 'Unclustered' regardless of mode", () => {
  const issueNoCluster: Issue = { ...baseIssue, cluster_id: null }
  for (const mode of ["topic", "cluster_family", "cluster_label", "cluster"] as const) {
    const out = buildStoryTimeline([issueNoCluster], new Map(), new Map(), mode)
    assert.equal(out[0]?.familyName, "Unclustered", `mode=${mode}`)
    assert.equal(out[0]?.familyColor, "#6b7280", `mode=${mode}`)
  }
})

test("parseCloudParam / modeToCloudParam round-trip", () => {
  assert.equal(parseCloudParam(null), "topic")
  assert.equal(parseCloudParam(undefined), "topic")
  assert.equal(parseCloudParam("nonsense"), "topic")
  assert.equal(parseCloudParam("family"), "cluster_family")
  assert.equal(parseCloudParam("label"), "cluster_label")
  assert.equal(parseCloudParam("cluster"), "cluster")

  assert.equal(modeToCloudParam("topic"), null)
  assert.equal(modeToCloudParam("cluster_family"), "family")
  assert.equal(modeToCloudParam("cluster_label"), "label")
  assert.equal(modeToCloudParam("cluster"), "cluster")
})

test("captionForMode returns a phrase for every mode", () => {
  assert.match(captionForMode("topic"), /heuristic/)
  assert.match(captionForMode("cluster_family"), /family title only/)
  assert.match(captionForMode("cluster_label"), /cluster label only/)
  assert.match(captionForMode("cluster"), /family title → label/)
})
