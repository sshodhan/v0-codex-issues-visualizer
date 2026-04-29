import { createHash } from "node:crypto"
import type { createAdminClient } from "@/lib/supabase/admin"
import { extractResponsesOutputText } from "@/lib/classification/openai-responses"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"
import { attachToCluster } from "@/lib/storage/clusters"
import {
  LABEL_MODEL,
  composeDeterministicLabel,
  mode,
  topicNameForSlug,
} from "@/lib/storage/cluster-label-fallback"
import { recordProcessingEvent } from "@/lib/storage/processing-events"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

import {
  buildEmbeddingInputText,
  clusterEmbeddings,
  type EmbeddedObservation,
  type SemanticObservationInput,
} from "@/lib/storage/semantic-cluster-core"

export interface SemanticClusterRunResult {
  processed: number
  semanticAttached: number
  fallbackAttached: number
  embeddingFailures: number
  labelingFailures: number
}

type AdminClient = ReturnType<typeof createAdminClient>

const DEFAULT_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small"
const DEFAULT_LABEL_MODEL = process.env.OPENAI_CLUSTER_LABEL_MODEL ?? "gpt-5-mini"
// Mirrors the classifier escalation pattern (lib/classification/pipeline.ts).
// When the small-model labelling response comes back below the escalation
// confidence floor, we retry once with the larger model. Defaults to the
// same small model so deployments that don't opt in see no behaviour change.
const DEFAULT_LABEL_MODEL_LARGE =
  process.env.OPENAI_CLUSTER_LABEL_MODEL_LARGE ?? DEFAULT_LABEL_MODEL
const LABEL_ESCALATE_BELOW = 0.7
const LABEL_ACCEPT_BELOW = 0.6
const LABEL_PROMPT_TITLE_LIMIT = 8
const LABEL_PROMPT_ERROR_CODE_LIMIT = 3

// OpenAI returns a request id on every response in the `x-request-id`
// header (matching the openai-node SDK's `_request_id` / `APIError.request_id`
// surface). Capturing it on both success and failure lets us cross-reference
// a specific call with the OpenAI dashboard / support trace.
function readOpenAiRequestId(response: Response): string | null {
  return response.headers.get("x-request-id") ?? response.headers.get("openai-request-id")
}

interface OpenAiErrorEnvelope {
  type: string | null
  code: string | null
  message: string | null
  param: string | null
}

// OpenAI's documented error shape is `{ error: { message, type, code, param } }`.
// Parse defensively so a non-JSON 5xx (e.g. an HTML edge-page) still surfaces
// useful breadcrumbs in the log.
async function readOpenAiErrorBody(response: Response): Promise<{
  envelope: OpenAiErrorEnvelope
  raw: string
}> {
  const raw = await response.text().catch(() => "")
  let envelope: OpenAiErrorEnvelope = { type: null, code: null, message: null, param: null }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { error?: Partial<OpenAiErrorEnvelope> }
      const err = parsed.error
      if (err && typeof err === "object") {
        envelope = {
          type: typeof err.type === "string" ? err.type : null,
          code: typeof err.code === "string" ? err.code : null,
          message: typeof err.message === "string" ? err.message : null,
          param: typeof err.param === "string" ? err.param : null,
        }
      }
    } catch {
      // non-JSON body — keep envelope empty, raw preserved below
    }
  }
  return { envelope, raw: raw.slice(0, 500) }
}

export const SEMANTIC_EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL

export async function createEmbedding(input: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logServer({
      component: "cluster-embedding",
      event: "openai_request_skipped",
      level: "warn",
      data: { reason: "missing_api_key", model: DEFAULT_EMBEDDING_MODEL },
    })
    return null
  }

  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_EMBEDDING_MODEL,
        input,
      }),
    })
  } catch (error) {
    logServerError("cluster-embedding", "openai_request_failed", error, {
      endpoint: "embeddings",
      model: DEFAULT_EMBEDDING_MODEL,
      latency_ms: Date.now() - startedAt,
    })
    return null
  }

  const requestId = readOpenAiRequestId(response)
  const latencyMs = Date.now() - startedAt

  if (!response.ok) {
    const { envelope, raw } = await readOpenAiErrorBody(response)
    logServer({
      component: "cluster-embedding",
      event: "openai_response_non_ok",
      level: "error",
      data: {
        endpoint: "embeddings",
        model: DEFAULT_EMBEDDING_MODEL,
        status: response.status,
        status_text: response.statusText,
        request_id: requestId,
        latency_ms: latencyMs,
        error_type: envelope.type,
        error_code: envelope.code,
        error_message: envelope.message,
        error_param: envelope.param,
        body_preview: envelope.message ? null : raw,
      },
    })
    return null
  }

  let payload: { data?: Array<{ embedding?: number[] }> }
  try {
    payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
  } catch (error) {
    logServerError("cluster-embedding", "openai_response_unparseable", error, {
      endpoint: "embeddings",
      model: DEFAULT_EMBEDDING_MODEL,
      status: response.status,
      request_id: requestId,
      latency_ms: latencyMs,
    })
    return null
  }

  const vector = payload.data?.[0]?.embedding
  if (!Array.isArray(vector)) {
    logServer({
      component: "cluster-embedding",
      event: "openai_response_unparseable",
      level: "error",
      data: {
        endpoint: "embeddings",
        model: DEFAULT_EMBEDDING_MODEL,
        status: response.status,
        request_id: requestId,
        latency_ms: latencyMs,
        reason: "missing_embedding_vector",
      },
    })
    return null
  }

  logServer({
    component: "cluster-embedding",
    event: "openai_request_succeeded",
    level: "info",
    data: {
      endpoint: "embeddings",
      model: DEFAULT_EMBEDDING_MODEL,
      status: response.status,
      request_id: requestId,
      latency_ms: latencyMs,
      vector_dim: vector.length,
    },
  })
  return vector
}

async function ensureEmbedding(
  supabase: AdminClient,
  observation: SemanticObservationInput,
): Promise<number[] | null> {
  const { data: existing } = await supabase
    .from("observation_embeddings")
    .select("vector")
    .eq("observation_id", observation.id)
    .eq("algorithm_version", CURRENT_VERSIONS.observation_embedding)
    .maybeSingle()

  const vectorJson = existing?.vector as number[] | string | undefined
  if (Array.isArray(vectorJson)) return vectorJson
  if (typeof vectorJson === "string") {
    try {
      const parsed = JSON.parse(vectorJson) as number[]
      if (Array.isArray(parsed)) return parsed
    } catch {
      // no-op; will regenerate
    }
  }

  const input = buildEmbeddingInputText(observation.title, observation.content)
  const embedding = await createEmbedding(input)
  if (!embedding) {
    await recordProcessingEvent(supabase, {
      observationId: observation.id,
      stage: "embedding",
      status: "failed",
      algorithmVersionModel: `${CURRENT_VERSIONS.observation_embedding}:${DEFAULT_EMBEDDING_MODEL}`,
      detail: { reason: "embedding_api_failed" },
    })
    return null
  }

  await supabase.rpc("record_observation_embedding", {
    obs_id: observation.id,
    ver: CURRENT_VERSIONS.observation_embedding,
    model_name: DEFAULT_EMBEDDING_MODEL,
    dims: embedding.length,
    input_text: input,
    vec: embedding,
  })
  await recordProcessingEvent(supabase, {
    observationId: observation.id,
    stage: "embedding",
    status: "completed",
    algorithmVersionModel: `${CURRENT_VERSIONS.observation_embedding}:${DEFAULT_EMBEDDING_MODEL}`,
    detail: { dimensions: embedding.length },
  })

  return embedding
}

function semanticClusterKey(observationIds: string[]): string {
  const stable = [...observationIds].sort().join("|")
  const digest = createHash("md5").update(stable).digest("hex").slice(0, 16)
  return `semantic:${digest}`
}

interface LlmLabelResult {
  label: string
  rationale: string
  confidence: number
  model: string
}

interface LabelInput {
  titles: string[]
  topicSlug: string | null
  errorCodes: string[]
}

// LLM cluster-name generator. Result is stored on `clusters.label` /
// `label_confidence` and surfaced in the UI as the Family's display
// name (the row title in "Top Families"). When the LLM call fails or
// confidence is too low, callers fall back to
// `composeDeterministicLabel(...)` — the UI then renders that derived
// label instead of "Unnamed family". Distinct from per-issue
// `llm_subcategory` (free-text on the classification record) — that's
// per-observation; this is per-cluster. See docs/ARCHITECTURE.md §6.0.
async function callLabelModel(
  modelName: string,
  input: LabelInput,
): Promise<LlmLabelResult | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logServer({
      component: "cluster-labeling",
      event: "openai_request_skipped",
      level: "warn",
      data: { reason: "missing_api_key", model: modelName },
    })
    return null
  }

  const topicName = topicNameForSlug(input.topicSlug)
  const contextLines: string[] = []
  if (topicName) {
    contextLines.push(`Likely Topic for the cluster: ${topicName}.`)
  }
  if (input.errorCodes.length > 0) {
    contextLines.push(`Recurring error codes: ${input.errorCodes.join(", ")}.`)
  }
  const contextBlock = contextLines.length > 0 ? `${contextLines.join("\n")}\n\n` : ""

  const titlesBlock = input.titles
    .slice(0, LABEL_PROMPT_TITLE_LIMIT)
    .map((t, idx) => `${idx + 1}. ${t}`)
    .join("\n")

  const userPrompt =
    "You are naming a cluster of related user-reported issues. Return JSON with keys " +
    "label (<= 6 words, topic-flavoured even when uncertain — e.g. 'Auth Issue Cluster' " +
    "rather than refusing), rationale (<= 1 sentence), confidence (0..1, lower it honestly " +
    "when the titles are heterogeneous; do not penalise terse but topical labels). " +
    "Prefer a label grounded in the supplied Topic and recurring error code when present.\n\n" +
    contextBlock +
    `Issue titles (${input.titles.length} total, showing up to ${LABEL_PROMPT_TITLE_LIMIT}):\n` +
    titlesBlock

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
            name: "cluster_label",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                rationale: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["label", "rationale", "confidence"],
            },
          },
        },
      }),
    })
  } catch (error) {
    logServerError("cluster-labeling", "openai_request_failed", error, {
      endpoint: "responses",
      model: modelName,
      title_count: input.titles.length,
      latency_ms: Date.now() - startedAt,
    })
    return null
  }

  const requestId = readOpenAiRequestId(response)
  const latencyMs = Date.now() - startedAt

  if (!response.ok) {
    const { envelope, raw } = await readOpenAiErrorBody(response)
    logServer({
      component: "cluster-labeling",
      event: "openai_response_non_ok",
      level: "error",
      data: {
        endpoint: "responses",
        model: modelName,
        status: response.status,
        status_text: response.statusText,
        request_id: requestId,
        latency_ms: latencyMs,
        title_count: input.titles.length,
        error_type: envelope.type,
        error_code: envelope.code,
        error_message: envelope.message,
        error_param: envelope.param,
        body_preview: envelope.message ? null : raw,
      },
    })
    return null
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    logServerError("cluster-labeling", "openai_response_unparseable", error, {
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
      component: "cluster-labeling",
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

  let parsed: { label?: string; rationale?: string; confidence?: number }
  try {
    parsed = JSON.parse(outputText) as {
      label?: string
      rationale?: string
      confidence?: number
    }
  } catch (error) {
    logServerError("cluster-labeling", "openai_response_unparseable", error, {
      endpoint: "responses",
      model: modelName,
      status: response.status,
      request_id: requestId,
      latency_ms: latencyMs,
      reason: "structured_output_not_json",
    })
    return null
  }

  if (!parsed.label || !parsed.rationale || typeof parsed.confidence !== "number") {
    logServer({
      component: "cluster-labeling",
      event: "openai_response_unparseable",
      level: "error",
      data: {
        endpoint: "responses",
        model: modelName,
        status: response.status,
        request_id: requestId,
        latency_ms: latencyMs,
        reason: "missing_required_fields",
        has_label: Boolean(parsed.label),
        has_rationale: Boolean(parsed.rationale),
        confidence_type: typeof parsed.confidence,
      },
    })
    return null
  }

  const confidence = Math.max(0, Math.min(parsed.confidence, 1))
  logServer({
    component: "cluster-labeling",
    event: "openai_request_succeeded",
    level: "info",
    data: {
      endpoint: "responses",
      model: modelName,
      status: response.status,
      request_id: requestId,
      latency_ms: latencyMs,
      title_count: input.titles.length,
      confidence,
    },
  })
  return {
    label: parsed.label.trim(),
    rationale: parsed.rationale.trim(),
    confidence,
    model: modelName,
  }
}

// Two-pass labeller: small model first, escalate to large on low
// confidence. Returns the best LLM result we got (may be low confidence)
// or null if both passes failed outright. Caller decides whether to use
// it or fall through to the deterministic fallback.
async function labelSemanticCluster(input: LabelInput): Promise<LlmLabelResult | null> {
  const small = await callLabelModel(DEFAULT_LABEL_MODEL, input)
  if (small && small.confidence >= LABEL_ESCALATE_BELOW) return small
  if (DEFAULT_LABEL_MODEL_LARGE === DEFAULT_LABEL_MODEL) return small
  const large = await callLabelModel(DEFAULT_LABEL_MODEL_LARGE, input)
  if (!large) return small
  if (!small) return large
  return large.confidence >= small.confidence ? large : small
}

export async function runSemanticClusteringForBatch(
  supabase: AdminClient,
  observations: SemanticObservationInput[],
  options?: {
    similarityThreshold?: number
    minClusterSize?: number
    redetach?: boolean
  },
): Promise<SemanticClusterRunResult> {
  const similarityThreshold = options?.similarityThreshold ?? 0.86
  const minClusterSize = options?.minClusterSize ?? 2
  const redetach = options?.redetach === true

  const embedded: EmbeddedObservation[] = []
  let embeddingFailures = 0

  for (const observation of observations) {
    const embedding = await ensureEmbedding(supabase, observation)
    if (!embedding) {
      embeddingFailures++
      continue
    }
    embedded.push({ ...observation, embedding })
  }

  const grouped = clusterEmbeddings(embedded, similarityThreshold, minClusterSize)
  const fallbackIds = new Set<string>([
    ...grouped.fallbackObservationIds,
    ...observations.filter((o) => !embedded.find((e) => e.id === o.id)).map((o) => o.id),
  ])

  let semanticAttached = 0
  let fallbackAttached = 0
  let labelingFailures = 0

  for (const group of grouped.semanticGroups) {
    const key = semanticClusterKey(group.map((g) => g.id))
    for (const member of group) {
      if (redetach) await supabase.rpc("detach_from_cluster", { obs_id: member.id })
      const attached = await supabase.rpc("attach_to_cluster", {
        obs_id: member.id,
        key,
      })
      if (!attached.error) {
        semanticAttached++
        await recordProcessingEvent(supabase, {
          observationId: member.id,
          stage: "clustering",
          status: "semantic_attached",
          algorithmVersionModel: CURRENT_VERSIONS.semantic_cluster_label,
          detail: { cluster_key: key, threshold: similarityThreshold, min_cluster_size: minClusterSize },
        })
      }
    }

    const { data: clusterIdResult } = await supabase
      .from("clusters")
      .select("id")
      .eq("cluster_key", key)
      .maybeSingle()

    const titles = group.map((g) => g.title)
    const topicSlugs = group.map((g) => g.topicSlug ?? null)
    const errorCodesAll = group.map((g) => g.errorCode ?? null)
    const distinctErrorCodes = Array.from(
      new Set(errorCodesAll.filter((c): c is string => Boolean(c))),
    ).slice(0, LABEL_PROMPT_ERROR_CODE_LIMIT)
    // Mode-based, lex-tiebreak: deterministic across runs and matches the
    // dominant topic the fallback labeller would pick from the same data.
    const dominantTopicSlug = mode(topicSlugs)

    const llm = await labelSemanticCluster({
      titles,
      topicSlug: dominantTopicSlug,
      errorCodes: distinctErrorCodes,
    })

    // Use the LLM label only if it cleared the accept threshold; below
    // that, the deterministic fallback is more honest than a confident-
    // looking but underspecified LLM string.
    let chosenLabel: string
    let chosenRationale: string
    let chosenConfidence: number
    let chosenModel: string
    let usedFallback = false

    if (llm && llm.confidence >= LABEL_ACCEPT_BELOW) {
      chosenLabel = llm.label
      chosenRationale = llm.rationale
      chosenConfidence = llm.confidence
      chosenModel = `${LABEL_MODEL.OPENAI_PREFIX}${llm.model}`
    } else {
      const fallback = composeDeterministicLabel({
        topicSlugs,
        errorCodes: errorCodesAll,
        titles,
      })
      chosenLabel = fallback.label
      chosenRationale = fallback.rationale
      chosenConfidence = fallback.confidence
      chosenModel = fallback.model
      usedFallback = true
    }

    let wroteLabel = false
    if (clusterIdResult?.id) {
      const updateRes = await supabase.rpc("set_cluster_label", {
        cluster_uuid: clusterIdResult.id,
        lbl: chosenLabel,
        lbl_rationale: chosenRationale,
        lbl_confidence: chosenConfidence,
        lbl_model: chosenModel,
        lbl_alg_ver: CURRENT_VERSIONS.semantic_cluster_label,
      })
      if (updateRes.error) labelingFailures++
      else wroteLabel = true
    } else {
      labelingFailures++
    }

    // Structured log so we can watch the fallback rate post-deploy and
    // catch regressions in LLM-label quality without scraping the DB.
    // `clusters.label_model` is the durable per-row audit trail; this
    // event is the time-series view, so it must only fire when the row
    // was actually written — otherwise the rate dashboard counts
    // would-be fallbacks the DB never saw.
    if (usedFallback && wroteLabel) {
      logServer({
        component: "cluster-labeling",
        event: "deterministic_fallback_used",
        level: "info",
        data: {
          cluster_key: key,
          cluster_id: clusterIdResult?.id ?? null,
          member_count: group.length,
          dominant_topic_slug: dominantTopicSlug,
          distinct_error_codes: distinctErrorCodes,
          llm_confidence: llm?.confidence ?? null,
          llm_model: llm?.model ?? null,
          chosen_model: chosenModel,
          chosen_confidence: chosenConfidence,
        },
      })
    }
  }

  for (const observation of observations) {
    if (!fallbackIds.has(observation.id)) continue
    if (redetach) await supabase.rpc("detach_from_cluster", { obs_id: observation.id })
    await attachToCluster(supabase, observation.id, observation.title)
    fallbackAttached++
    await recordProcessingEvent(supabase, {
      observationId: observation.id,
      stage: "clustering",
      status: "fallback_attached",
      algorithmVersionModel: CURRENT_VERSIONS.semantic_cluster_label,
      detail: { reason: "insufficient_semantic_similarity_or_embedding_failure" },
    })
  }

  return {
    processed: observations.length,
    semanticAttached,
    fallbackAttached,
    embeddingFailures,
    labelingFailures,
  }
}
