import test from "node:test"
import assert from "node:assert/strict"

import { buildV3InputFromObservation } from "../lib/embeddings/v3-input-from-observation.ts"

// ============================================================================
// Mock Supabase client.
//
// The fetcher does five `from(...)` chains in parallel, each returning
// either { data, error: null } or { data: null, error: ... }. We mock
// just enough surface area to drive the assembler's branches without a
// real DB. Each mock returns a chainable object that captures the
// query and resolves to a configured payload.
// ============================================================================

type MockResponse<T> = { data: T | null; error: { message: string } | null }

interface MockTableConfig<T = any> {
  response: MockResponse<T>
}

function makeMockClient(tables: Record<string, MockTableConfig>): any {
  return {
    from(tableName: string) {
      const config = tables[tableName] ?? { response: { data: null, error: null } }

      // Builder pattern that ignores all chained method calls and
      // resolves to the configured response on `.maybeSingle()` /
      // `.then()`.
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        is: () => builder,
        gte: () => builder,
        maybeSingle: () => Promise.resolve(config.response),
        then: (onFulfilled: (r: MockResponse<any>) => any) => Promise.resolve(config.response).then(onFulfilled),
      }
      return builder
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
}

// ============================================================================
// Happy path — every side table returns data. The v3 helper should
// produce a fully-populated tier-ordered output.
// ============================================================================

test("buildV3InputFromObservation: fully-populated row produces full v3 text", async () => {
  const supabase = makeMockClient({
    category_assignments: {
      response: { data: { category_id: "cat-1", categories: { slug: "performance" } }, error: null },
    },
    bug_fingerprints: {
      response: {
        data: {
          error_code: "TIMEOUT",
          top_stack_frame: "save_handler",
          cli_version: "0.10.4",
          os: "macos",
          shell: "zsh",
          editor: "vscode",
          model_id: "gpt-4o",
          repro_markers: 3,
        },
        error: null,
      },
    },
    classifications: {
      response: {
        data: {
          category: "bugs",
          subcategory: "ui-freeze",
          primary_tag: "blocking",
          severity: "high",
          confidence: 0.9,
          reproducibility: "always",
          impact: "single-user",
          tags: ["alpha", "beta"],
          created_at: "2026-05-01T00:00:00Z",
        },
        error: null,
      },
    },
    classification_reviews: {
      response: {
        data: { category: null, subcategory: null, severity: null, status: null, needs_human_review: false, reviewed_at: null, classifications: { observation_id: "obs-1" } },
        error: null,
      },
    },
  })

  const result = await buildV3InputFromObservation(supabase, {
    id: "obs-1",
    title: "App freezes on save",
    content: "Body content",
  })

  // Tier 1 — primary signals
  assert.match(result.text, /^Title: App freezes on save$/m)
  assert.match(result.text, /^Summary: Body content$/m)
  assert.match(result.text, /^Topic: performance$/m)
  assert.match(result.text, /^Category: bugs$/m)
  assert.match(result.text, /^Subcategory: ui-freeze$/m)
  assert.match(result.text, /^Tags: alpha, beta$/m)

  // Tier 2 — secondary
  assert.match(result.text, /^Severity: high$/m)
  assert.match(result.text, /^Reproducibility: always$/m)
  assert.match(result.text, /^Impact: single-user$/m)
  assert.match(result.text, /^Confidence: high$/m)

  // Tier 3 — supportive (collapsed)
  assert.match(result.text, /^Environment: cli=0\.10\.4 os=macos shell=zsh editor=vscode model=gpt-4o$/m)
  assert.match(result.text, /^Error: TIMEOUT$/m)
  assert.match(result.text, /^Stack: save_handler$/m)
  assert.match(result.text, /^Repro markers: 3$/m)

  // Side-table summary reflects full success
  assert.equal(result.sideTableSummary.topic_lookup, "found")
  assert.equal(result.sideTableSummary.fingerprint_lookup, "found")
  assert.equal(result.sideTableSummary.classification_lookup, "found")
  assert.equal(result.sideTableSummary.review_lookup, "found")
})

// ============================================================================
// Best-effort degradation — failed side-table queries don't throw.
// ============================================================================

test("buildV3InputFromObservation: classification lookup failure degrades to Tier 1 minus LLM", async () => {
  const supabase = makeMockClient({
    category_assignments: {
      response: { data: { categories: { slug: "performance" } }, error: null },
    },
    bug_fingerprints: {
      response: { data: null, error: null }, // no fingerprint row
    },
    classifications: {
      response: { data: null, error: { message: "lookup failed" } }, // failed
    },
    classification_reviews: {
      response: { data: null, error: null },
    },
  })

  const result = await buildV3InputFromObservation(supabase, {
    id: "obs-2",
    title: "T",
    content: null,
  })

  // Title + Topic still present
  assert.match(result.text, /^Title: T$/m)
  assert.match(result.text, /^Topic: performance$/m)

  // No LLM-derived lines (classification failed → fields all null →
  // canUseTaxonomySignals returns false)
  assert.doesNotMatch(result.text, /^Category:/m)
  assert.doesNotMatch(result.text, /^Subcategory:/m)
  assert.doesNotMatch(result.text, /^Tags:/m)
  assert.doesNotMatch(result.text, /^Severity:/m)
  assert.doesNotMatch(result.text, /^Confidence:/m)

  // No fingerprint lines (no row)
  assert.doesNotMatch(result.text, /^Environment:/m)
  assert.doesNotMatch(result.text, /^Error:/m)
  assert.doesNotMatch(result.text, /^Stack:/m)

  // Side-table summary reflects the failure
  assert.equal(result.sideTableSummary.classification_lookup, "failed")
  assert.equal(result.sideTableSummary.fingerprint_lookup, "not_found")
})

// ============================================================================
// Review override propagates — reviewer_category > llm_category in v3 text.
// ============================================================================

test("buildV3InputFromObservation: reviewer override beats LLM category", async () => {
  const supabase = makeMockClient({
    category_assignments: {
      response: { data: { categories: { slug: "performance" } }, error: null },
    },
    bug_fingerprints: { response: { data: null, error: null } },
    classifications: {
      response: {
        data: {
          category: "bugs",
          subcategory: "other",
          primary_tag: null,
          severity: "medium",
          confidence: 0.9,
          reproducibility: null,
          impact: null,
          tags: [],
          created_at: "2026-05-01",
        },
        error: null,
      },
    },
    classification_reviews: {
      response: {
        data: {
          category: "usability",
          subcategory: "keyboard-shortcuts",
          severity: null,
          status: null,
          needs_human_review: false,
          reviewed_at: "2026-05-01",
          classifications: { observation_id: "obs-3" },
        },
        error: null,
      },
    },
  })

  const result = await buildV3InputFromObservation(supabase, {
    id: "obs-3",
    title: "T",
    content: null,
  })

  // Reviewer override won
  assert.match(result.text, /^Category: usability$/m)
  assert.match(result.text, /^Subcategory: keyboard-shortcuts$/m)
  // LLM-original NOT in output
  assert.doesNotMatch(result.text, /^Category: bugs$/m)
  assert.doesNotMatch(result.text, /^Subcategory: other$/m)
})

// ============================================================================
// Review-flagged status omits Tier 1 LLM AND Tier 2 scalars.
// ============================================================================

test("buildV3InputFromObservation: review-flagged status gates all LLM-sourced lines", async () => {
  const supabase = makeMockClient({
    category_assignments: { response: { data: { categories: { slug: "performance" } }, error: null } },
    bug_fingerprints: { response: { data: null, error: null } },
    classifications: {
      response: {
        data: {
          category: "bugs",
          subcategory: "ui",
          primary_tag: null,
          severity: "high",
          confidence: 0.9,
          reproducibility: "always",
          impact: "single-user",
          tags: ["alpha"],
          created_at: "2026-05-01",
        },
        error: null,
      },
    },
    classification_reviews: {
      response: {
        data: {
          category: null,
          subcategory: null,
          severity: null,
          status: "rejected",
          needs_human_review: true,
          reviewed_at: "2026-05-01",
          classifications: { observation_id: "obs-4" },
        },
        error: null,
      },
    },
  })

  const result = await buildV3InputFromObservation(supabase, {
    id: "obs-4",
    title: "T",
    content: null,
  })

  // Title + Topic still emitted (not LLM-derived)
  assert.match(result.text, /^Title: T$/m)
  assert.match(result.text, /^Topic: performance$/m)

  // ALL LLM signals (Tier 1 + Tier 2) gated out by review_flagged
  assert.doesNotMatch(result.text, /^Category:/m)
  assert.doesNotMatch(result.text, /^Subcategory:/m)
  assert.doesNotMatch(result.text, /^Tags:/m)
  assert.doesNotMatch(result.text, /^Severity:/m)
  assert.doesNotMatch(result.text, /^Reproducibility:/m)
  assert.doesNotMatch(result.text, /^Impact:/m)
  assert.doesNotMatch(result.text, /^Confidence:/m)
})

// ============================================================================
// Title-only fallback — every side-table empty.
// ============================================================================

test("buildV3InputFromObservation: title-only when nothing else available", async () => {
  const supabase = makeMockClient({}) // all tables return { data: null, error: null }

  const result = await buildV3InputFromObservation(supabase, {
    id: "obs-5",
    title: "Crash",
    content: null,
  })

  // Just Title — no Topic, no LLM, no fingerprint
  assert.equal(result.text, "Title: Crash")

  assert.equal(result.sideTableSummary.topic_lookup, "not_found")
  assert.equal(result.sideTableSummary.fingerprint_lookup, "not_found")
  assert.equal(result.sideTableSummary.classification_lookup, "not_found")
  assert.equal(result.sideTableSummary.review_lookup, "not_found")
})
