import { createHash } from "node:crypto"
import type { createAdminClient } from "@/lib/supabase/admin"
import { extractResponsesOutputText } from "@/lib/classification/openai-responses"
import { buildV3InputFromObservation } from "@/lib/embeddings/v3-input-from-observation"
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
  percentile,
  type EmbeddedObservation,
  type EmbeddingStructuredSignals,
  type SemanticObservationInput,
} from "@/lib/storage/semantic-cluster-core"

export interface SemanticClusterRunResult {
  processed: number
  semanticAttached: number
  fallbackAttached: number
  embeddingFailures: number
  labelingFailures: number
  /** Per-batch observability: how many embeddings were served from
   *  the DB cache vs freshly fetched from OpenAI, and the latency
   *  distribution of fetched calls. Surfaced to admin clients for
   *  debugging silent rebuild stalls. */
  embeddingStats: {
    cached: number
    fetched: number
    failed: number
    fetchLatencyP50Ms: number | null
    fetchLatencyP95Ms: number | null
    fetchLatencyMaxMs: number | null
  }
  /** Coverage of v2 structured-prefix signals across the batch. v2
   *  embeddings degrade gracefully to prose-only input when signals
   *  are absent — this counter set tells operators whether v2 is
   *  actually delivering type-anchored embeddings or silently behaving
   *  like v1 for most observations. `withAnySignal` and
   *  `withStrongSignal` are derived (any-of-five and
   *  any-of-{type,errorCode,topStackFrame}) so the operator doesn't
   *  have to compute them client-side. Always includes every
   *  observation passed in, even those that failed embedding — so the
   *  ratio is "share of input with X populated", not "share of
   *  successfully embedded with X populated".
   */
  embeddingSignalCoverage: {
    total: number
    withType: number
    withErrorCode: number
    withComponent: number
    withTopStackFrame: number
    withPlatform: number
    withAnySignal: number
    withStrongSignal: number
  }
  /** Number of semantic groups (clusters of size >= minClusterSize) the
   *  algorithm formed, plus the largest such group's size. Together they
   *  let an operator see "did this batch produce real grouping?" without
   *  needing a follow-up SQL query. */
  semanticGroupsFormed: number
  largestGroupSize: number
  /** Pairwise similarity histogram from clusterEmbeddings — used to
   *  decide whether the active threshold is too tight/loose. */
  similarityHistogram: {
    buckets: Record<string, number>
    invalid: number
    totalPairs: number
  }
  /** Wall-clock duration of the run, useful when correlating with the
   *  Vercel 300s function-timeout boundary. */
  durationMs: number
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

async function createEmbedding(input: string): Promise<number[] | null> {
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

/** Outcome of `ensureEmbedding`. `source` distinguishes a DB cache hit
 *  from a fresh OpenAI fetch so the caller can build per-batch
 *  cache-hit-rate / fetch-latency stats without re-instrumenting the
 *  internals of `recomputeObservationEmbedding`. */
type EnsureEmbeddingOutcome =
  | { ok: true; vector: number[]; source: "cache" | "fetched"; latencyMs: number }
  | { ok: false; latencyMs: number }

async function ensureEmbedding(
  supabase: AdminClient,
  observation: SemanticObservationInput,
  signals?: EmbeddingStructuredSignals,
): Promise<EnsureEmbeddingOutcome> {
  const startedAt = Date.now()
  const { data: existing } = await supabase
    .from("observation_embeddings")
    .select("vector")
    .eq("observation_id", observation.id)
    .eq("algorithm_version", CURRENT_VERSIONS.observation_embedding)
    .maybeSingle()

  const vectorJson = existing?.vector as number[] | string | undefined
  if (Array.isArray(vectorJson)) {
    return { ok: true, vector: vectorJson, source: "cache", latencyMs: Date.now() - startedAt }
  }
  if (typeof vectorJson === "string") {
    try {
      const parsed = JSON.parse(vectorJson) as number[]
      if (Array.isArray(parsed)) {
        return { ok: true, vector: parsed, source: "cache", latencyMs: Date.now() - startedAt }
      }
    } catch {
      // no-op; will regenerate
    }
  }

  const outcome = await recomputeObservationEmbedding(supabase, observation, {
    trigger: "ensure",
    signals,
  })
  if (outcome.ok) {
    return { ok: true, vector: outcome.vector, source: "fetched", latencyMs: Date.now() - startedAt }
  }
  return { ok: false, latencyMs: Date.now() - startedAt }
}

// Force-recompute the observation_embedding for a single row and upsert
// via record_observation_embedding (the RPC is on-conflict-do-update,
// scripts/012_semantic_clustering.sql §record_observation_embedding).
// Always writes the corresponding processing event so the trace stream
// stays append-complete regardless of trigger. Used by:
//   - ensureEmbedding (above) when no row exists at the current
//     algorithm_version.
//   - app/api/observations/[id]/rerun for the user-triggered "Re-run"
//     button on the trace page.
// The `trigger` option is only persisted into the processing event's
// detail_json so we can distinguish batch fills from manual reruns
// when reading the audit log later.
export async function recomputeObservationEmbedding(
  supabase: AdminClient,
  observation: { id: string; title: string; content?: string | null },
  options: { trigger?: string; signals?: EmbeddingStructuredSignals } = {},
): Promise<
  | { ok: true; vector: number[]; model: string; algorithmVersion: string; dimensions: number }
  | { ok: false; reason: string }
> {
  const trigger = options.trigger ?? "unspecified"
  const algorithmVersionModel = `${CURRENT_VERSIONS.observation_embedding}:${DEFAULT_EMBEDDING_MODEL}`

  // Version dispatch — produces the embedding-input text. Each
  // version corresponds to a specific helper:
  //
  //   v2 → buildEmbeddingInputText (lib/storage/semantic-cluster-core.ts)
  //        Bracketed structured signals prepended to title/body.
  //        Inputs come from the caller's `options.signals` shape.
  //
  //   v3 → buildClassificationAwareEmbeddingText (lib/embeddings/
  //        classification-aware-input.ts), with input fetched from
  //        five upstream tables by buildV3InputFromObservation.
  //        Tier-ordered for the user-feedback corpus signal hierarchy
  //        (PR #193's plan amendment). The v3 path IGNORES
  //        `options.signals` because v3 needs a richer input set
  //        (LLM 4.a category/subcategory/tags + reviewer override +
  //        full bug fingerprint + Topic) than the v2 signals shape
  //        carries — it fetches its own.
  //
  // This is a runtime branch on a single constant. Adding a v4 means
  // adding a new branch here AND bumping CURRENT_VERSIONS.observation_embedding
  // AND adding scripts/0XX_observation_embedding_v4_bump.sql.
  let input: string
  let v3Detail: Record<string, unknown> | undefined
  if (CURRENT_VERSIONS.observation_embedding === "v3") {
    const v3 = await buildV3InputFromObservation(supabase, observation)
    input = v3.text
    v3Detail = { v3_side_tables: v3.sideTableSummary }
  } else {
    // v1 / v2 path. v1 (no signals) collapses to prose-only output
    // by buildEmbeddingInputText's degraded-input behavior.
    input = buildEmbeddingInputText(
      observation.title,
      observation.content ?? null,
      options.signals,
    )
  }
  const embedding = await createEmbedding(input)
  if (!embedding) {
    await recordProcessingEvent(supabase, {
      observationId: observation.id,
      stage: "embedding",
      status: "failed",
      algorithmVersionModel,
      detail: { reason: "embedding_api_failed", trigger },
    })
    return { ok: false, reason: "embedding_api_failed" }
  }

  const { error: rpcError } = await supabase.rpc("record_observation_embedding", {
    obs_id: observation.id,
    ver: CURRENT_VERSIONS.observation_embedding,
    model_name: DEFAULT_EMBEDDING_MODEL,
    dims: embedding.length,
    input_text: input,
    vec: embedding as any,
  })
  if (rpcError) {
    await recordProcessingEvent(supabase, {
      observationId: observation.id,
      stage: "embedding",
      status: "failed",
      algorithmVersionModel,
      detail: { reason: "rpc_failed", message: rpcError.message, trigger },
    })
    return { ok: false, reason: rpcError.message }
  }
  await recordProcessingEvent(supabase, {
    observationId: observation.id,
    stage: "embedding",
    status: "completed",
    algorithmVersionModel,
    detail: { dimensions: embedding.length, trigger, ...(v3Detail ?? {}) },
  })

  return {
    ok: true,
    vector: embedding,
    model: DEFAULT_EMBEDDING_MODEL,
    algorithmVersion: CURRENT_VERSIONS.observation_embedding,
    dimensions: embedding.length,
  }
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
  const runStartedAt = Date.now()

  const embedded: EmbeddedObservation[] = []
  let embeddingFailures = 0
  let embeddingsFromCache = 0
  let embeddingsFromFetch = 0
  // Latencies of OpenAI fetch calls only (cache hits skipped) — used for
  // p50/p95 reporting after the batch.
  const fetchLatencies: number[] = []
  // v2 signal-coverage tally. Counted across the FULL input set
  // (including obs that subsequently fail embedding), because the
  // operator question is "how many of my observations have the type
  // signal populated?" — not "of those that successfully embedded".
  // A non-empty trimmed string counts; null / undefined / "" / "  "
  // do not (matches buildEmbeddingInputText's omission rule).
  const coverage = {
    total: observations.length,
    withType: 0,
    withErrorCode: 0,
    withComponent: 0,
    withTopStackFrame: 0,
    withPlatform: 0,
    withAnySignal: 0,
    withStrongSignal: 0,
  }
  const present = (s: string | null | undefined) => Boolean(s && s.trim())

  for (const observation of observations) {
    // Build the v2 structured-signal payload from the observation's
    // optional context fields. Each absent field is silently omitted by
    // buildEmbeddingInputText; an observation with no signals at all
    // still embeds successfully with prose-only input.
    const signals: EmbeddingStructuredSignals = {
      type: observation.familyKind ?? null,
      errorCode: observation.errorCode ?? null,
      component: observation.topicSlug ?? null,
      topStackFrame: observation.topStackFrame ?? null,
      platform: observation.platform ?? null,
    }
    const hasType = present(signals.type)
    const hasError = present(signals.errorCode)
    const hasComponent = present(signals.component)
    const hasFrame = present(signals.topStackFrame)
    const hasPlatform = present(signals.platform)
    if (hasType) coverage.withType++
    if (hasError) coverage.withErrorCode++
    if (hasComponent) coverage.withComponent++
    if (hasFrame) coverage.withTopStackFrame++
    if (hasPlatform) coverage.withPlatform++
    if (hasType || hasError || hasComponent || hasFrame || hasPlatform) {
      coverage.withAnySignal++
    }
    // "Strong" = any of the three signals that are most discriminating
    // for issue type. component (heuristic Topic slug) is broad and
    // platform alone tells you little, so they don't qualify on their own.
    if (hasType || hasError || hasFrame) coverage.withStrongSignal++

    const outcome = await ensureEmbedding(supabase, observation, signals)
    if (!outcome.ok) {
      embeddingFailures++
      continue
    }
    if (outcome.source === "cache") embeddingsFromCache++
    else {
      embeddingsFromFetch++
      fetchLatencies.push(outcome.latencyMs)
    }
    embedded.push({ ...observation, embedding: outcome.vector })
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

  const durationMs = Date.now() - runStartedAt
  const semanticGroupsFormed = grouped.semanticGroups.length
  const largestGroupSize = semanticGroupsFormed
    ? Math.max(...grouped.semanticGroups.map((g) => g.length))
    : 0
  const fetchLatencyP50Ms = percentile(fetchLatencies, 0.5)
  const fetchLatencyP95Ms = percentile(fetchLatencies, 0.95)
  const fetchLatencyMaxMs = fetchLatencies.length ? Math.max(...fetchLatencies) : null

  // Single structured event per batch with everything an operator needs
  // to diagnose a rebuild post-mortem (was the threshold too tight? did
  // OpenAI rate-limit us? did anything actually merge?). Mirrors the
  // depth of the per-call openai_request_succeeded log but at the batch
  // level so 487 obs don't produce 487 noisy lines.
  logServer({
    component: "admin-cluster",
    event: "rebuild_batch_completed",
    level: "info",
    data: {
      processed: observations.length,
      embedded: embedded.length,
      embeddings_cached: embeddingsFromCache,
      embeddings_fetched: embeddingsFromFetch,
      embeddings_failed: embeddingFailures,
      fetch_latency_p50_ms: fetchLatencyP50Ms,
      fetch_latency_p95_ms: fetchLatencyP95Ms,
      fetch_latency_max_ms: fetchLatencyMaxMs,
      similarity_threshold: similarityThreshold,
      min_cluster_size: minClusterSize,
      redetach,
      semantic_groups_formed: semanticGroupsFormed,
      largest_group_size: largestGroupSize,
      semantic_attached: semanticAttached,
      fallback_attached: fallbackAttached,
      labeling_failures: labelingFailures,
      similarity_histogram: grouped.similarityHistogram,
      embedding_signal_coverage: coverage,
      duration_ms: durationMs,
    },
  })

  return {
    processed: observations.length,
    semanticAttached,
    fallbackAttached,
    embeddingFailures,
    labelingFailures,
    embeddingStats: {
      cached: embeddingsFromCache,
      fetched: embeddingsFromFetch,
      failed: embeddingFailures,
      fetchLatencyP50Ms,
      fetchLatencyP95Ms,
      fetchLatencyMaxMs,
    },
    embeddingSignalCoverage: coverage,
    semanticGroupsFormed,
    largestGroupSize,
    similarityHistogram: grouped.similarityHistogram,
    durationMs,
  }
}

