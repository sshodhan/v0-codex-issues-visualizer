import { createHash } from "node:crypto"
import type { createAdminClient } from "@/lib/supabase/admin"
import { extractResponsesOutputText } from "@/lib/classification/openai-responses"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"
import { attachToCluster } from "@/lib/storage/clusters"
import { recordProcessingEvent } from "@/lib/storage/processing-events"

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

async function createEmbedding(input: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  const response = await fetch("https://api.openai.com/v1/embeddings", {
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

  if (!response.ok) return null

  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
  const vector = payload.data?.[0]?.embedding
  return Array.isArray(vector) ? vector : null
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

async function labelSemanticCluster(titles: string[]): Promise<{
  label: string
  rationale: string
  confidence: number
} | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_LABEL_MODEL,
      input: [
        {
          role: "user",
          content:
            "Given these issue titles, return JSON with keys label (<=6 words), rationale (<=1 sentence), confidence (0..1). Titles:\n" +
            titles.map((t, idx) => `${idx + 1}. ${t}`).join("\n"),
        },
      ],
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

  if (!response.ok) return null
  const payload = (await response.json()) as unknown
  const outputText = extractResponsesOutputText(payload)
  if (typeof outputText !== "string") return null

  try {
    const parsed = JSON.parse(outputText) as {
      label?: string
      rationale?: string
      confidence?: number
    }
    if (!parsed.label || !parsed.rationale || typeof parsed.confidence !== "number") return null
    return {
      label: parsed.label.trim(),
      rationale: parsed.rationale.trim(),
      confidence: Math.max(0, Math.min(parsed.confidence, 1)),
    }
  } catch {
    return null
  }
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

    const first = group[0]
    const { data: clusterIdResult } = await supabase
      .from("clusters")
      .select("id")
      .eq("cluster_key", key)
      .maybeSingle()

    const label = await labelSemanticCluster(group.map((g) => g.title))
    if (clusterIdResult?.id && label) {
      const updateRes = await supabase.rpc("set_cluster_label", {
        cluster_uuid: clusterIdResult.id,
        lbl: label.label,
        lbl_rationale: label.rationale,
        lbl_confidence: label.confidence,
        lbl_model: DEFAULT_LABEL_MODEL,
        lbl_alg_ver: CURRENT_VERSIONS.semantic_cluster_label,
      })
      if (updateRes.error) labelingFailures++
    } else {
      labelingFailures++
      if (clusterIdResult?.id) {
        await supabase.rpc("set_cluster_label", {
          cluster_uuid: clusterIdResult.id,
          lbl: first.title.slice(0, 80),
          lbl_rationale: "Fallback label from canonical title because model labeling failed.",
          lbl_confidence: 0.25,
          lbl_model: "fallback:title",
          lbl_alg_ver: CURRENT_VERSIONS.semantic_cluster_label,
        })
      }
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
