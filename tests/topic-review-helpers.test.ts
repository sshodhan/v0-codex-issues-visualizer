import { describe, it } from "node:test"
import * as assert from "node:assert"
import {
  buildManualOverrideEvidence,
  buildGoldenSetCandidate,
  isReasonCode,
  isSuggestedLayer,
  isSuggestedAction,
  isReviewStatus,
} from "../lib/admin/topic-review.ts"

describe("topic review helpers", () => {
  describe("validator guards", () => {
    it("isReasonCode accepts valid codes and rejects others", () => {
      assert.strictEqual(isReasonCode("phrase_false_positive"), true)
      assert.strictEqual(isReasonCode("other"), true)
      assert.strictEqual(isReasonCode("invalid_code"), false)
      assert.strictEqual(isReasonCode(123), false)
      assert.strictEqual(isReasonCode(null), false)
    })

    it("isSuggestedLayer accepts valid stage values and rejects others", () => {
      // The DB column is still named `suggested_layer` (PR #151 review
      // explicitly allowed keeping the column name to avoid an invasive
      // rename), but the VALUES are stage-named per PR #162's 5-stage
      // model: regex_topic, embedding, clustering, llm_classification_family,
      // human_review_workflow, data_quality, unknown.
      assert.strictEqual(isSuggestedLayer("regex_topic"), true)
      assert.strictEqual(isSuggestedLayer("clustering"), true)
      assert.strictEqual(isSuggestedLayer("llm_classification_family"), true)
      assert.strictEqual(isSuggestedLayer("human_review_workflow"), true)
      assert.strictEqual(isSuggestedLayer("data_quality"), true)
      assert.strictEqual(isSuggestedLayer("unknown"), true)
      // Old layer-named values are no longer accepted.
      assert.strictEqual(isSuggestedLayer("layer_0_topic"), false)
      assert.strictEqual(isSuggestedLayer("layer_a_cluster"), false)
      assert.strictEqual(isSuggestedLayer("layer_c_llm_classification"), false)
      assert.strictEqual(isSuggestedLayer("bad_layer"), false)
      assert.strictEqual(isSuggestedLayer(undefined), false)
    })

    it("isSuggestedAction accepts valid actions and rejects others", () => {
      assert.strictEqual(isSuggestedAction("none"), true)
      assert.strictEqual(isSuggestedAction("add_golden_row"), true)
      assert.strictEqual(isSuggestedAction("bad_action"), false)
    })

    it("isReviewStatus accepts valid statuses and rejects others", () => {
      assert.strictEqual(isReviewStatus("new"), true)
      assert.strictEqual(isReviewStatus("accepted"), true)
      assert.strictEqual(isReviewStatus("bad_status"), false)
    })
  })

  describe("buildManualOverrideEvidence", () => {
    it("constructs override evidence with all required fields", () => {
      const ev = buildManualOverrideEvidence({
        overriddenAssignment: {
          algorithmVersion: "v6",
          categoryId: "cat-123",
          slug: "bug",
          confidence: 0.85,
        },
        corrected: {
          categoryId: "cat-456",
          slug: "feature-request",
        },
        reasonCode: "phrase_false_positive",
        suggestedLayer: "regex_topic",
        suggestedAction: "add_golden_row",
        rationale: "This is actually a feature request",
        reviewer: "alice@example.com",
      })

      assert.strictEqual(ev.override, true)
      assert.strictEqual(ev.override_type, "topic")
      assert.deepStrictEqual(ev.overridden_assignment, {
        algorithm_version: "v6",
        category_id: "cat-123",
        slug: "bug",
        confidence: 0.85,
      })
      assert.deepStrictEqual(ev.corrected, {
        category_id: "cat-456",
        slug: "feature-request",
      })
      assert.strictEqual(ev.reason_code, "phrase_false_positive")
      assert.strictEqual(ev.suggested_layer, "regex_topic")
      assert.strictEqual(ev.suggested_action, "add_golden_row")
      assert.strictEqual(ev.rationale, "This is actually a feature request")
      assert.strictEqual(ev.reviewer, "alice@example.com")
      assert.ok(ev.reviewed_at)
      assert.ok(new Date(ev.reviewed_at).getTime() > 0)
    })

    it("uses provided reviewed_at timestamp when given", () => {
      const timestamp = "2026-04-28T10:00:00Z"
      const ev = buildManualOverrideEvidence({
        overriddenAssignment: {
          algorithmVersion: "v6",
          categoryId: "cat-1",
          slug: "bug",
          confidence: 0.5,
        },
        corrected: { categoryId: "cat-2", slug: "feature-request" },
        reasonCode: "other",
        suggestedLayer: "unknown",
        suggestedAction: "none",
        rationale: null,
        reviewer: "admin",
        reviewedAt: timestamp,
      })

      assert.strictEqual(ev.reviewed_at, timestamp)
    })

    it("handles null values in overridden assignment", () => {
      const ev = buildManualOverrideEvidence({
        overriddenAssignment: {
          algorithmVersion: null,
          categoryId: null,
          slug: null,
          confidence: null,
        },
        corrected: { categoryId: "cat-x", slug: "other" },
        reasonCode: "known_limitation",
        suggestedLayer: "data_quality",
        suggestedAction: "known_limitation_no_action",
        rationale: null,
        reviewer: "local_admin",
      })

      assert.deepStrictEqual(ev.overridden_assignment, {
        algorithm_version: null,
        category_id: null,
        slug: null,
        confidence: null,
      })
    })
  })

  describe("buildGoldenSetCandidate", () => {
    it("builds golden-set row with corrected slug when present", () => {
      const candidate = buildGoldenSetCandidate({
        title: "Model hallucinates",
        body: "The model says things that are wrong.",
        correctedSlug: "model-quality",
        currentSlug: "bug",
      })

      assert.ok(candidate)
      assert.strictEqual(candidate.title, "Model hallucinates")
      assert.strictEqual(candidate.body, "The model says things that are wrong.")
      assert.strictEqual(candidate.expected, "model-quality")
    })

    it("falls back to current slug when corrected is null", () => {
      const candidate = buildGoldenSetCandidate({
        title: "Feature: dark mode",
        body: "Please add dark mode support.",
        correctedSlug: null,
        currentSlug: "feature-request",
      })

      assert.ok(candidate)
      assert.strictEqual(candidate.expected, "feature-request")
    })

    it("returns null when both slugs are null", () => {
      const candidate = buildGoldenSetCandidate({
        title: "Some issue",
        body: "Description",
        correctedSlug: null,
        currentSlug: null,
      })

      assert.strictEqual(candidate, null)
    })

    it("prefers corrected slug even when current is present", () => {
      const candidate = buildGoldenSetCandidate({
        title: "Test",
        body: "Body",
        correctedSlug: "correct-slug",
        currentSlug: "wrong-slug",
      })

      assert.ok(candidate)
      assert.strictEqual(candidate.expected, "correct-slug")
    })
  })
})
