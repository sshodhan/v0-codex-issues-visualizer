import type { SupabaseClient } from "@supabase/supabase-js"

// Relative imports (instead of @/ alias) so this module can be loaded
// directly by `node --test` for the heuristic unit tests in
// tests/family-classification.test.ts. Same pattern as
// lib/storage/cluster-topic-metadata.ts.
import { extractResponsesOutputText } from "../classification/openai-responses.ts"
import { CURRENT_VERSIONS } from "./algorithm-versions.ts"
import { getClusterTopicMetadata } from "./cluster-topic-metadata.ts"
import { logServer, logServerError } from "../error-tracking/server-logger.ts"

const LOG_COMPONENT = "family-classification"

type AdminClient = SupabaseClient

// Heuristic-first family classification rules. These determine
// `family_kind` and initial `needs_human_review` without LLM calls.
// The LLM pass (if available) can refine `needs_human_review` and
// add mechanism-specific title/summary, but the heuristic foundation
// is deterministic and always runs.

export type FamilyKind =
  | "coherent_single_issue"
  | "mixed_multi_causal"
  | "needs_split_review"
  | "low_evidence"
  | "unclear"

export type SeverityRollup = "low" | "medium" | "high" | "critical" | "unknown"

export interface FamilyClassificationDraft {
  cluster_id: string
  algorithm_version: string
  family_title: string
  family_summary: string
  family_kind: FamilyKind
  dominant_topic_slug: string | null
  primary_failure_mode: string | null
  affected_surface: string | null
  likely_owner_area: string | null
  severity_rollup: SeverityRollup
  confidence: number
  needs_human_review: boolean
  review_reasons: string[]
  evidence: Record<string, unknown>
}

export interface HeuristicResult {
  family_kind: FamilyKind
  needs_human_review: boolean
  review_reasons: string[]
}

export interface HeuristicInput {
  classification_coverage_share: number
  mixed_topic_score: number
  dominant_topic_share: number
  /** evidence.scoring.margin <= margin_threshold members. Used to
   *  distinguish "Family is genuinely multi-causal" (Layer 0 confident,
   *  Topics just differ) from "Family needs split review" (Layer 0 also
   *  unsure on the boundaries). See cluster-topic-metadata.ts. */
  low_margin_count: number
  observation_count: number
  /** "fallback" clusters are key-based rather than embedding-based, so
   *  they get an automatic review reason regardless of other signals. */
  cluster_path: "semantic" | "fallback"
  /** Mean of evidence.scoring.confidence_proxy [0..1] across members.
   *  Below ~0.3 means Layer 0 itself is hesitant about each member's
   *  Topic — flag for review even when the aggregate looks coherent. */
  avg_confidence_proxy: number | null
}

// Threshold constants (named so the rule names self-document).
const LOW_COVERAGE_THRESHOLD = 0.5
const HIGH_COVERAGE_THRESHOLD = 0.8
const HIGH_MIXED_THRESHOLD = 0.6
const COHERENT_DOMINANT_THRESHOLD = 0.75
// If at least this share of members are low-margin, the mixed-topic
// branch escalates from "mixed_multi_causal" to "needs_split_review".
const LOW_MARGIN_SPLIT_SHARE = 0.4
const LOW_AVG_CONFIDENCE_THRESHOLD = 0.3

// Deterministic rules to classify a cluster into family_kind +
// needs_human_review. Always runs, never depends on OpenAI.
//
// Two passes:
//   1. Auxiliary signals (cluster_path, avg_confidence_proxy) accumulate
//      review_reasons but do not change family_kind on their own.
//   2. The kind decision walks the four mutually-exclusive rules below.
//      The mixed-topic branch fans out into two kinds based on Layer 0
//      margin: "mixed_multi_causal" if Layer 0 is confident on each
//      member, "needs_split_review" if many members are close calls.
export function classifyFamilyHeuristic(input: HeuristicInput): HeuristicResult {
  const auxReasons: string[] = []
  let auxNeedsReview = false

  if (input.cluster_path === "fallback") {
    auxReasons.push("fallback_cluster_path")
    auxNeedsReview = true
  }
  if (
    input.avg_confidence_proxy != null &&
    input.avg_confidence_proxy < LOW_AVG_CONFIDENCE_THRESHOLD
  ) {
    auxReasons.push("low_avg_layer0_confidence")
    auxNeedsReview = true
  }

  // Rule 1: low coverage → low_evidence (always needs review)
  if (input.classification_coverage_share < LOW_COVERAGE_THRESHOLD) {
    return {
      family_kind: "low_evidence",
      needs_human_review: true,
      review_reasons: ["low_classification_coverage", ...auxReasons],
    }
  }

  // Rule 2: mixed-topic branch (high entropy AND enough coverage to trust it)
  if (
    input.mixed_topic_score >= HIGH_MIXED_THRESHOLD &&
    input.classification_coverage_share >= HIGH_COVERAGE_THRESHOLD
  ) {
    const lowMarginShare =
      input.observation_count > 0
        ? input.low_margin_count / input.observation_count
        : 0
    if (lowMarginShare >= LOW_MARGIN_SPLIT_SHARE) {
      return {
        family_kind: "needs_split_review",
        needs_human_review: true,
        review_reasons: [
          "high_topic_mixedness",
          "many_close_topic_calls",
          ...auxReasons,
        ],
      }
    }
    return {
      family_kind: "mixed_multi_causal",
      needs_human_review: auxNeedsReview,
      review_reasons: ["high_topic_mixedness", ...auxReasons],
    }
  }

  // Rule 3: high dominant share → coherent_single_issue
  if (input.dominant_topic_share >= COHERENT_DOMINANT_THRESHOLD) {
    return {
      family_kind: "coherent_single_issue",
      needs_human_review: auxNeedsReview,
      review_reasons: auxReasons,
    }
  }

  // Rule 4: fallthrough → unclear + needs review
  return {
    family_kind: "unclear",
    needs_human_review: true,
    review_reasons: ["mixed_or_unclear_signals", ...auxReasons],
  }
}

interface LlmTitleInput {
  representative_titles: string[]
  topic_distribution: Record<string, number>
  dominant_topic_slug: string | null
  common_matched_phrases: Array<{ slug: string; phrase: string; count: number }>
  classification_coverage_share: number
  mixed_topic_score: number
  low_margin_count: number
  observation_count: number
}

export interface LlmTitleProvenance {
  model: string
  request_id: string | null
  latency_ms: number
  /** Bumped whenever the prompt or schema changes — lets reviewers
   *  filter LLM rows by the prompt revision they came from. */
  prompt_template_version: string
}

interface LlmTitleResult {
  family_title: string
  family_summary: string
  primary_failure_mode: string | null
  affected_surface: string | null
  likely_owner_area: string | null
  confidence: number
  rationale: string
  provenance: LlmTitleProvenance
}

const DEFAULT_LLM_MODEL = process.env.OPENAI_CLUSTER_LABEL_MODEL ?? "gpt-5-mini"
const PROMPT_TEMPLATE_VERSION = "family-title-v1"

// Length caps for human-displayed strings. Enforced both in the JSON
// schema (so the model knows) and in the parser (so a non-conformant
// response can't break the admin table layout).
const TITLE_MAX_CHARS = 80
const SUMMARY_MAX_CHARS = 400
const RATIONALE_MAX_CHARS = 200

function clipText(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1).trimEnd() + "…"
}

// "auth_error" → "Auth Error", "model-quality" → "Model Quality".
// Used for deterministic-fallback titles so admin tables don't render
// SHOUTING SLUGS.
function titleCaseSlug(slug: string | null): string {
  if (!slug) return "Cluster"
  return slug
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
}

function humanizeFamilyKind(kind: FamilyKind): string {
  switch (kind) {
    case "coherent_single_issue":
      return "appears to be a single coherent issue"
    case "mixed_multi_causal":
      return "spans multiple distinct causes"
    case "needs_split_review":
      return "may need to be split into multiple families"
    case "low_evidence":
      return "lacks classification coverage to be confident"
    case "unclear":
      return "has mixed signals that don't fit a single pattern"
  }
}

function readOpenAiRequestId(response: Response): string | null {
  return response.headers.get("x-request-id") ?? response.headers.get("openai-request-id")
}

async function readOpenAiErrorBody(response: Response): Promise<{
  envelope: { type: string | null; code: string | null; message: string | null }
  raw: string
}> {
  const raw = await response.text().catch(() => "")
  let envelope = { type: null, code: null, message: null }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { error?: Record<string, unknown> }
      const err = parsed.error
      if (err && typeof err === "object") {
        envelope = {
          type: typeof err.type === "string" ? err.type : null,
          code: typeof err.code === "string" ? err.code : null,
          message: typeof err.message === "string" ? err.message : null,
        }
      }
    } catch {
      // non-JSON body
    }
  }
  return { envelope, raw: raw.slice(0, 500) }
}

// LLM title/summary generator for families. Optional; if OpenAI fails
// or is not configured, the heuristic draft is still valid (just with
// lower confidence and a deterministic title).
async function callFamilyTitleModel(
  modelName: string,
  input: LlmTitleInput,
): Promise<LlmTitleResult | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logServer({
      component: LOG_COMPONENT,
      event: "openai_request_skipped",
      level: "warn",
      data: { reason: "missing_api_key", model: modelName },
    })
    return null
  }

  const titlesBlock = input.representative_titles
    .slice(0, 8)
    .map((t, idx) => `${idx + 1}. ${t}`)
    .join("\n")

  const phrasesBlock =
    input.common_matched_phrases.length > 0
      ? `Common matched phrases:\n${input.common_matched_phrases
          .slice(0, 10)
          .map((p) => `  - "${p.phrase}" (${p.slug}, ${p.count}x)`)
          .join("\n")}`
      : ""

  // Format topic_distribution as percentages (D5 readability). Counts
  // alone require the model to do mental arithmetic at large N.
  const totalTopicCount = Object.values(input.topic_distribution).reduce(
    (sum, n) => sum + n,
    0,
  )
  const topicDistributionStr = Object.entries(input.topic_distribution)
    .sort(([, a], [, b]) => b - a)
    .map(([slug, count]) => {
      const pct = totalTopicCount > 0 ? Math.round((count / totalTopicCount) * 100) : 0
      return `${slug} ${pct}% (${count})`
    })
    .join(", ")

  const userPrompt =
    "You are analyzing a cluster of issue reports about Codex, an AI " +
    "coding agent. Common failure modes include: tool-call timeouts, " +
    "sandbox/permission errors, MCP integration failures, model " +
    "regressions, rate-limit gating, login/auth flow failures, and " +
    "merge/branch conflicts during agent edits. " +
    `Return JSON with keys: family_title (<= ${TITLE_MAX_CHARS} chars, ` +
    "mechanism-specific, e.g. 'Login timeout after rate limit'), " +
    `family_summary (<= 2 sentences, <= ${SUMMARY_MAX_CHARS} chars), ` +
    "primary_failure_mode (the mechanism, null if unclear), " +
    "affected_surface (API/CLI/Web, null if mixed), " +
    "likely_owner_area (team or subsystem, null if unclear), " +
    "confidence (0..1, lower if evidence is mixed), " +
    `rationale (<= 1 sentence, <= ${RATIONALE_MAX_CHARS} chars).\n\n` +
    `Dominant Topic: ${input.dominant_topic_slug ?? "unclassified"}\n` +
    `Topic distribution: ${topicDistributionStr}\n` +
    `Classification coverage: ${(input.classification_coverage_share * 100).toFixed(1)}%\n` +
    `Mixed topic score: ${input.mixed_topic_score.toFixed(3)} (0=single-topic, 1=uniform)\n` +
    `Low-margin observations (close topic calls): ${input.low_margin_count}/${input.observation_count}\n\n` +
    (phrasesBlock ? `${phrasesBlock}\n\n` : "") +
    `Issue titles (${input.representative_titles.length} shown):\n${titlesBlock}`

  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        input: [{ role: "user", content: userPrompt }],
        text: {
          format: {
            // strict mode requires every property be listed in `required`
            // (nullable fields use union types). This makes the OpenAI
            // structured-output guarantee meaningful — non-conformant
            // responses are rejected upstream rather than silently
            // dropped here.
            type: "json_schema",
            name: "family_title",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                family_title: { type: "string", maxLength: TITLE_MAX_CHARS },
                family_summary: { type: "string", maxLength: SUMMARY_MAX_CHARS },
                primary_failure_mode: { type: ["string", "null"] },
                affected_surface: { type: ["string", "null"] },
                likely_owner_area: { type: ["string", "null"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                rationale: { type: "string", maxLength: RATIONALE_MAX_CHARS },
              },
              required: [
                "family_title",
                "family_summary",
                "primary_failure_mode",
                "affected_surface",
                "likely_owner_area",
                "confidence",
                "rationale",
              ],
            },
          },
        },
      }),
    })
  } catch (error) {
    logServerError(LOG_COMPONENT, "openai_request_failed", error, {
      endpoint: "responses",
      model: modelName,
      latency_ms: Date.now() - startedAt,
    })
    return null
  }

  const requestId = readOpenAiRequestId(response)
  const latencyMs = Date.now() - startedAt

  if (!response.ok) {
    const { envelope, raw } = await readOpenAiErrorBody(response)
    logServer({
      component: LOG_COMPONENT,
      event: "openai_response_non_ok",
      level: "error",
      data: {
        endpoint: "responses",
        model: modelName,
        status: response.status,
        status_text: response.statusText,
        request_id: requestId,
        latency_ms: latencyMs,
        error_type: envelope.type,
        error_code: envelope.code,
        error_message: envelope.message,
      },
    })
    return null
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    logServerError(LOG_COMPONENT, "openai_response_unparseable", error, {
      endpoint: "responses",
      model: modelName,
      status: response.status,
      request_id: requestId,
      latency_ms: latencyMs,
      reason: "json_parse_failed",
    })
    return null
  }

  const outputText = extractResponsesOutputText(payload)
  if (typeof outputText !== "string") {
    logServer({
      component: LOG_COMPONENT,
      event: "openai_response_unparseable",
      level: "error",
      data: {
        endpoint: "responses",
        model: modelName,
        status: response.status,
        request_id: requestId,
        latency_ms: latencyMs,
        reason: "missing_output_text",
      },
    })
    return null
  }

  let parsed: {
    family_title?: string
    family_summary?: string
    primary_failure_mode?: string | null
    affected_surface?: string | null
    likely_owner_area?: string | null
    confidence?: number
    rationale?: string
  }
  try {
    parsed = JSON.parse(outputText)
  } catch (error) {
    logServerError(LOG_COMPONENT, "openai_response_unparseable", error, {
      endpoint: "responses",
      model: modelName,
      status: response.status,
      request_id: requestId,
      latency_ms: latencyMs,
      reason: "structured_output_not_json",
    })
    return null
  }

  if (
    !parsed.family_title ||
    !parsed.family_summary ||
    typeof parsed.confidence !== "number" ||
    !parsed.rationale
  ) {
    logServer({
      component: LOG_COMPONENT,
      event: "openai_response_unparseable",
      level: "error",
      data: {
        endpoint: "responses",
        model: modelName,
        status: response.status,
        request_id: requestId,
        latency_ms: latencyMs,
        reason: "missing_required_fields",
      },
    })
    return null
  }

  const confidence = Math.max(0, Math.min(parsed.confidence, 1))
  logServer({
    component: LOG_COMPONENT,
    event: "openai_request_succeeded",
    level: "info",
    data: {
      endpoint: "responses",
      model: modelName,
      status: response.status,
      request_id: requestId,
      latency_ms: latencyMs,
      confidence,
    },
  })

  return {
    family_title: clipText(parsed.family_title.trim(), TITLE_MAX_CHARS),
    family_summary: clipText(parsed.family_summary.trim(), SUMMARY_MAX_CHARS),
    primary_failure_mode: parsed.primary_failure_mode
      ? String(parsed.primary_failure_mode).trim() || null
      : null,
    affected_surface: parsed.affected_surface
      ? String(parsed.affected_surface).trim() || null
      : null,
    likely_owner_area: parsed.likely_owner_area
      ? String(parsed.likely_owner_area).trim() || null
      : null,
    confidence,
    rationale: clipText(parsed.rationale.trim(), RATIONALE_MAX_CHARS),
    provenance: {
      model: modelName,
      request_id: requestId,
      latency_ms: latencyMs,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
    },
  }
}

// Main classifier: heuristic-first, then optional LLM refinement.
export async function classifyClusterFamily(
  supabase: AdminClient,
  clusterId: string,
): Promise<FamilyClassificationDraft | null> {
  // Fetch cluster topic metadata (the Layer A signal).
  const metadata = await getClusterTopicMetadata(supabase, clusterId)
  if (!metadata) {
    logServerError(LOG_COMPONENT, "cluster_topic_metadata_not_found", new Error("Missing metadata"), {
      cluster_id: clusterId,
    })
    return null
  }

  // Fetch cluster + members to get representative titles.
  const { data: cluster } = await supabase
    .from("clusters")
    .select("id, cluster_key, canonical_observation_id")
    .eq("id", clusterId)
    .maybeSingle()

  if (!cluster) {
    logServerError(LOG_COMPONENT, "cluster_not_found", new Error("Missing cluster"), {
      cluster_id: clusterId,
    })
    return null
  }

  // Fetch the 8 most-recently-attached active members. Slicing here
  // (instead of in the observations query) means the LLM prompt sees a
  // deterministic ordered set: the same cluster yields the same titles
  // run-to-run, which matters for caching and reproducibility.
  // `is("detached_at", null)` is the PostgREST shape for `IS NULL` —
  // `eq("detached_at", null)` would compile to `= NULL` and match
  // nothing.
  const { data: members } = await supabase
    .from("cluster_members")
    .select("observation_id, attached_at")
    .eq("cluster_id", clusterId)
    .is("detached_at", null)
    .order("attached_at", { ascending: false })
    .limit(8)

  let representative_titles: string[] = []
  if (members && members.length > 0) {
    const orderedIds = (members as Array<{ observation_id: string }>).map(
      (m) => m.observation_id,
    )
    const { data: observations } = await supabase
      .from("mv_observation_current")
      .select("observation_id, title")
      .in("observation_id", orderedIds)

    if (observations) {
      // .in() does not preserve order — re-key by observation_id and
      // reassemble in the original attached_at-desc order.
      const titleByObs = new Map(
        (
          observations as Array<{ observation_id: string; title: string | null }>
        ).map((o) => [o.observation_id, o.title || "Untitled"]),
      )
      representative_titles = orderedIds.map(
        (id) => titleByObs.get(id) ?? "Untitled",
      )
    }
  }

  // Apply heuristic rules. The new inputs (low_margin_count,
  // cluster_path, avg_confidence_proxy) let the heuristic distinguish
  // mixed_multi_causal vs needs_split_review and pick up review
  // reasons the bare three-signal version missed.
  const heuristic = classifyFamilyHeuristic({
    classification_coverage_share: metadata.classification_coverage_share,
    mixed_topic_score: metadata.mixed_topic_score,
    dominant_topic_share: metadata.dominant_topic_share,
    low_margin_count: metadata.low_margin_count,
    observation_count: metadata.observation_count,
    cluster_path: metadata.cluster_path,
    avg_confidence_proxy: metadata.avg_confidence_proxy,
  })

  // Try LLM title generation if OpenAI is available.
  let llmResult: LlmTitleResult | null = null
  if (process.env.OPENAI_API_KEY && representative_titles.length > 0) {
    llmResult = await callFamilyTitleModel(DEFAULT_LLM_MODEL, {
      representative_titles,
      topic_distribution: metadata.topic_distribution,
      dominant_topic_slug: metadata.dominant_topic_slug,
      common_matched_phrases: metadata.common_matched_phrases,
      classification_coverage_share: metadata.classification_coverage_share,
      mixed_topic_score: metadata.mixed_topic_score,
      low_margin_count: metadata.low_margin_count,
      observation_count: metadata.observation_count,
    })
  }

  // Fallback title if LLM unavailable.
  let family_title: string
  let family_summary: string
  let confidence: number
  let primary_failure_mode: string | null = null
  let affected_surface: string | null = null
  let likely_owner_area: string | null = null

  if (llmResult && llmResult.confidence >= 0.5) {
    family_title = llmResult.family_title
    family_summary = llmResult.family_summary
    confidence = llmResult.confidence
    primary_failure_mode = llmResult.primary_failure_mode
    affected_surface = llmResult.affected_surface
    likely_owner_area = llmResult.likely_owner_area
  } else {
    // Deterministic fallback. Title-case the slug (D1) — uppercase
    // SHOUTING reads badly in admin tables. Humanize the summary (D2)
    // — raw enum values like "needs_split_review" are not sentences.
    const topicDisplay = titleCaseSlug(metadata.dominant_topic_slug)
    const topPhrase =
      metadata.common_matched_phrases.length > 0
        ? metadata.common_matched_phrases[0].phrase
        : representative_titles[0] || "Family"
    family_title = clipText(`${topicDisplay} — ${topPhrase}`, TITLE_MAX_CHARS)
    const reportWord = metadata.observation_count === 1 ? "report" : "reports"
    family_summary = clipText(
      `${metadata.observation_count} ${reportWord}; ${humanizeFamilyKind(heuristic.family_kind)}.`,
      SUMMARY_MAX_CHARS,
    )
    // Confidence in the heuristic-only path is a function of the
    // signals: a 200-cluster, 95% coverage, 90% dominant cluster
    // shouldn't share a confidence floor with a 5-cluster, 50% coverage
    // one. Use min(coverage, dominant) capped at 0.6 — high enough to
    // be trusted, low enough to advertise the LLM didn't sign off.
    confidence = Math.min(
      0.6,
      Math.max(
        0.2,
        Math.min(
          metadata.classification_coverage_share,
          metadata.dominant_topic_share,
        ),
      ),
    )
  }

  // Build evidence payload for audit. Provenance lets reviewers trace
  // a row back to the exact LLM call (model + request_id + latency +
  // prompt template version) that produced it.
  const evidence = {
    cluster_topic_metadata: {
      cluster_path: metadata.cluster_path,
      observation_count: metadata.observation_count,
      classified_count: metadata.classified_count,
      classification_coverage_share: metadata.classification_coverage_share,
      topic_distribution: metadata.topic_distribution,
      dominant_topic_slug: metadata.dominant_topic_slug,
      dominant_topic_share: metadata.dominant_topic_share,
      mixed_topic_score: metadata.mixed_topic_score,
      low_margin_count: metadata.low_margin_count,
      avg_confidence_proxy: metadata.avg_confidence_proxy,
      common_matched_phrases: metadata.common_matched_phrases,
    },
    representatives: representative_titles.slice(0, 5),
    llm_result: llmResult
      ? {
          confidence: llmResult.confidence,
          rationale: llmResult.rationale,
          provenance: llmResult.provenance,
        }
      : null,
  }

  return {
    cluster_id: clusterId,
    algorithm_version: CURRENT_VERSIONS.family_classification,
    family_title,
    family_summary,
    family_kind: heuristic.family_kind,
    dominant_topic_slug: metadata.dominant_topic_slug,
    primary_failure_mode,
    affected_surface,
    likely_owner_area,
    // severity_rollup is reserved for a future pass that derives
    // severity from issue body / sentiment / impact. v1 always emits
    // "unknown" by design — see CLUSTERING_DESIGN.md §5.1.
    severity_rollup: "unknown",
    confidence,
    needs_human_review: heuristic.needs_human_review,
    review_reasons: heuristic.review_reasons,
    evidence,
  }
}
