import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt.ts"
import { CLASSIFICATION_SCHEMA } from "./schema.ts"

export function buildClassifierResponsesBody(userTurn: string, model: string) {
  return {
    model,
    input: [
      { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
      { role: "user", content: userTurn },
    ],
    text: {
      format: {
        type: "json_schema",
        ...CLASSIFICATION_SCHEMA,
      },
    },
  }
}

interface OpenAiResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

// Responses API can return model text in either:
//   - top-level `output_text` (legacy convenience field)
//   - `output[].content[]` blocks (`output_text` / `text`)
export function extractResponsesOutputText(payload: unknown): string | null {
  const root = asRecord(payload)
  if (!root) return null

  if (typeof root.output_text === "string") {
    return root.output_text
  }

  const output = root.output
  if (!Array.isArray(output)) return null

  for (const block of output) {
    const blockRecord = asRecord(block)
    if (!blockRecord) continue
    const content = blockRecord.content
    if (!Array.isArray(content)) continue

    for (const item of content) {
      const itemRecord = asRecord(item)
      if (!itemRecord) continue
      if (typeof itemRecord.text === "string") return itemRecord.text
      if (typeof itemRecord.output_text === "string") return itemRecord.output_text
    }
  }

  return null
}

export async function requestClassifierResponse(
  apiKey: string,
  userTurn: string,
  model: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<OpenAiResponseLike> = fetch,
): Promise<unknown> {
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildClassifierResponsesBody(userTurn, model)),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`OpenAI error: ${response.status} ${errorBody}`)
  }

  return response.json()
}
