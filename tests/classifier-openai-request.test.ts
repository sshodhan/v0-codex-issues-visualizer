import test from "node:test"
import assert from "node:assert/strict"

import { buildClassifierResponsesBody, requestClassifierResponse } from "../lib/classification/openai-responses.ts"

test("classifier /v1/responses body uses text.format json_schema and omits response_format", () => {
  const body = buildClassifierResponsesBody("report_text: sample", "gpt-5-mini") as Record<string, unknown>

  assert.equal(body.model, "gpt-5-mini")
  assert.ok(typeof body.text === "object" && body.text !== null)

  const text = body.text as Record<string, unknown>
  assert.ok(typeof text.format === "object" && text.format !== null)

  const format = text.format as Record<string, unknown>
  assert.equal(format.type, "json_schema")
  assert.equal(format.name, "codex_issue_classification")
  assert.ok(typeof format.schema === "object" && format.schema !== null)
  assert.equal(format.strict, true)
  assert.equal("response_format" in body, false)
  assert.equal("temperature" in body, false)
})

test("requestClassifierResponse sends text.format body via fetch and preserves downstream error payload text", async () => {
  let seenBody: Record<string, unknown> | null = null

  const okFetch = async (_input: string, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return {
      ok: true,
      status: 200,
      async text() {
        return ""
      },
      async json() {
        return { output_text: '{"category":"other"}' }
      },
    }
  }

  const payload = await requestClassifierResponse("test-key", "report_text: sample", "gpt-5-mini", okFetch)
  assert.deepEqual(payload, { output_text: '{"category":"other"}' })

  assert.ok(seenBody)
  assert.equal("response_format" in (seenBody as Record<string, unknown>), false)
  assert.equal("temperature" in (seenBody as Record<string, unknown>), false)
  const sentText = (seenBody as Record<string, unknown>).text as Record<string, unknown>
  assert.equal(((sentText.format as Record<string, unknown>).type), "json_schema")

  const failingFetch = async () => ({
    ok: false,
    status: 400,
    async text() {
      return '{"error":{"message":"schema validation failed: confidence is required"}}'
    },
    async json() {
      return {}
    },
  })

  await assert.rejects(
    () => requestClassifierResponse("test-key", "report_text: sample", "gpt-5-mini", failingFetch),
    /schema validation failed: confidence is required/,
  )
})
