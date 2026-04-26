export interface SemanticObservationInput {
  id: string
  title: string
  content?: string | null
  // Optional Topic / fingerprint context, used by the deterministic
  // fallback labeller when the LLM call fails or returns low confidence
  // (lib/storage/cluster-label-fallback.ts). Not consumed by the
  // embedding/clustering math itself, so callers that don't have these
  // signals (legacy providers, ad-hoc rebuilds) may safely omit them.
  topicSlug?: string | null
  errorCode?: string | null
}

export interface EmbeddedObservation extends SemanticObservationInput {
  embedding: number[]
}

export interface SemanticGroupingResult {
  semanticGroups: EmbeddedObservation[][]
  fallbackObservationIds: string[]
}

function norm(vector: number[]): number {
  let sum = 0
  for (const v of vector) sum += v * v
  return Math.sqrt(sum)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  const denom = norm(a) * norm(b)
  if (!Number.isFinite(denom) || denom === 0) return -1
  return dot / denom
}

export function buildEmbeddingInputText(title: string, content?: string | null): string {
  if (content && content.trim()) {
    const summary = content.trim().slice(0, 1200)
    return `Title: ${title.trim()}\nSummary: ${summary}`
  }
  return `Title: ${title.trim()}`
}

export function clusterEmbeddings(
  observations: EmbeddedObservation[],
  similarityThreshold: number,
  minClusterSize: number,
): SemanticGroupingResult {
  const visited = new Set<string>()
  const semanticGroups: EmbeddedObservation[][] = []
  const fallbackObservationIds: string[] = []

  const adjacency = new Map<string, Set<string>>()
  for (const obs of observations) adjacency.set(obs.id, new Set())

  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      const sim = cosineSimilarity(observations[i].embedding, observations[j].embedding)
      if (sim >= similarityThreshold) {
        adjacency.get(observations[i].id)?.add(observations[j].id)
        adjacency.get(observations[j].id)?.add(observations[i].id)
      }
    }
  }

  const byId = new Map(observations.map((o) => [o.id, o]))
  for (const obs of observations) {
    if (visited.has(obs.id)) continue
    const queue = [obs.id]
    visited.add(obs.id)
    const component: EmbeddedObservation[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      const row = byId.get(id)
      if (row) component.push(row)
      for (const next of adjacency.get(id) ?? []) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }

    if (component.length >= minClusterSize) semanticGroups.push(component)
    else fallbackObservationIds.push(...component.map((c) => c.id))
  }

  return { semanticGroups, fallbackObservationIds }
}
