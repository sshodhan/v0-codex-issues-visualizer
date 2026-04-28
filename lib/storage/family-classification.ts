import type { SupabaseClient } from "@supabase/supabase-js"
import { extractResponsesOutputText } from "@/lib/classification/openai-responses"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"
import { getClusterTopicMetadata } from "@/lib/storage/cluster-topic-metadata"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

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

interface HeuristicResult {
  family_kind: FamilyKind
  needs_human_review: boolean
  review_reasons: string[]
}

// Deterministic rules to classify a cluster into family_kind +
// needs_human_review signal. Does not require OpenAI.
function classifyFamilyHeuristic(input: {
  classification_coverage_share: number
  mixed_topic_score: number
  dominant_topic_share: number
}): HeuristicResult {
  // Rule 1: low coverage → low_evidence + needs review
  if (input.classification_coverage_share < 0.5) {
    return {
      family_kind: "low_evidence",
      needs_human_review: true,
      review_reasons: ["low_classification_coverage"],
    }
  }

  // Rule 2: high mixed score with good coverage → needs_split_review
  if (input.mixed_topic_score >= 0.6 && input.classification_coverage_share >= 0.8) {
    return {
      family_kind: "needs_split_review",
      needs_human_review: true,
      review_reasons: ["high_topic_mixedness"],
    }
  }

  // Rule 3: high dominant share → coherent_single_issue
  if (input.dominant_topic_share >= 0.75) {
    return {
      family_kind: "coherent_single_issue",
      needs_human_review: false,
      review_reasons: [],
    }
  }

  // Rule 4: everything else → unclear + needs review
  return {
    family_kind: "unclear",
    needs_human_review: true,
    review_reasons: ["mixed_or_unclear_signals"],
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

interface LlmTitleResult {
  family_title: string
  family_summary: string
  primary_failure_mode: string | null
  affected_surface: string | null
  likely_owner_area: string | null
  confidence: number
  rationale: string
}

const DEFAULT_LLM_MODEL = process.env.OPENAI_CLUSTER_LABEL_MODEL ?? "gpt-5-mini"

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

  const topicDistributionStr = Object.entries(input.topic_distribution)
    .map(([slug, count]) => `${slug}: ${count}`)
    .join(", ")

  const userPrompt =
    "You are analyzing a cluster of related user-reported issues. " +
    "Return JSON with keys: family_title (<= 8 words, mechanism-specific, " +
    "e.g. 'Login timeout after rate limit'), family_summary (<= 2 sentences), " +
    "primary_failure_mode (the mechanism, null if unclear), affected_surface (API/CLI/Web, null if mixed), " +
    "likely_owner_area (team or subsystem, null if unclear), confidence (0..1, lower if evidence is mixed), " +
    "and rationale (<= 1 sentence).\n\n" +
    `Dominant Topic: ${input.dominant_topic_slug ?? "unclassified"}\n` +
    `Topic distribution: ${topicDistributionStr}\n` +
    `Classification coverage: ${(input.classification_coverage_share * 100).toFixed(1)}%\n` +
    `Mixed topic score: ${input.mixed_topic_score.toFixed(3)} (0=single-topic, 1=uniform)\n` +
    `Low-margin observations (close topic calls): ${input.low_margin_count}/${input.observation_count}\n\n` +
    (phrasesBlock ? `${phrasesBlock}\n\n` : "") +
    `Issue titles (${input.representative_titles.length} total, showing up to 8):\n${titlesBlock}`

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
            type: "json_schema",
            name: "family_title",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                family_title: { type: "string" },
                family_summary: { type: "string" },
                primary_failure_mode: { type: ["string", "null"] },
                affected_surface: { type: ["string", "null"] },
                likely_owner_area: { type: ["string", "null"] },
                confidence: { type: "number" },
                rationale: { type: "string" },
              },
              required: [
                "family_title",
                "family_summary",
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
    family_title: parsed.family_title.trim(),
    family_summary: parsed.family_summary.trim(),
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
    rationale: parsed.rationale.trim(),
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

  // Fetch active members for representative titles.
  const { data: members } = await supabase
    .from("cluster_members")
    .select("observation_id")
    .eq("cluster_id", clusterId)
    .eq("detached_at", null)
    .order("attached_at", { ascending: false })
    .limit(20)

  let representative_titles: string[] = []
  if (members && members.length > 0) {
    const { data: observations } = await supabase
      .from("mv_observation_current")
      .select("title")
      .in(
        "observation_id",
        members.map((m) => m.observation_id),
      )
      .limit(8)

    if (observations) {
      representative_titles = observations.map((o) => o.title || "Untitled")
    }
  }

  // Apply heuristic rules.
  const heuristic = classifyFamilyHeuristic({
    classification_coverage_share: metadata.classification_coverage_share,
    mixed_topic_score: metadata.mixed_topic_score,
    dominant_topic_share: metadata.dominant_topic_share,
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
    // Deterministic fallback: topic + error + top phrase.
    const topicDisplay = metadata.dominant_topic_slug
      ? metadata.dominant_topic_slug.toUpperCase()
      : "Cluster"
    const topPhrase =
      metadata.common_matched_phrases.length > 0
        ? metadata.common_matched_phrases[0].phrase
        : representative_titles[0] || "Family"
    family_title = `${topicDisplay}: ${topPhrase}`
    family_summary = `Cluster of ${metadata.observation_count} observations, ${heuristic.family_kind}.`
    confidence = 0.35
  }

  // Build evidence payload for audit.
  const evidence = {
    cluster_topic_metadata: {
      observation_count: metadata.observation_count,
      classified_count: metadata.classified_count,
      classification_coverage_share: metadata.classification_coverage_share,
      topic_distribution: metadata.topic_distribution,
      dominant_topic_slug: metadata.dominant_topic_slug,
      dominant_topic_share: metadata.dominant_topic_share,
      mixed_topic_score: metadata.mixed_topic_score,
      low_margin_count: metadata.low_margin_count,
      common_matched_phrases: metadata.common_matched_phrases,
    },
    representatives: representative_titles.slice(0, 5),
    llm_result: llmResult
      ? {
          confidence: llmResult.confidence,
          rationale: llmResult.rationale,
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
    severity_rollup: "unknown",
    confidence,
    needs_human_review: heuristic.needs_human_review,
    review_reasons: heuristic.review_reasons,
    evidence,
  }
}
