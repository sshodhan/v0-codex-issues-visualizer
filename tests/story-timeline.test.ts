import test from "node:test"
import assert from "node:assert/strict"
import { buildStoryTimeline } from "../lib/dashboard/story-timeline.ts"
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
