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
