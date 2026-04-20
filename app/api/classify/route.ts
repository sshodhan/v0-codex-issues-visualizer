import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { toDbRecord, type ClassificationApiRecord } from "@/lib/classification/mapping"
import { CLASSIFIER_SYSTEM_PROMPT } from "@/lib/classification/prompt"
import { buildClassificationUserTurn } from "@/lib/classification/report-summary"
import { CLASSIFICATION_SCHEMA, evidenceQuotesAreSubstrings, validateEnumFields } from "@/lib/classification/schema"

const classifyInputSchema = z.object({
  report_text: z.string().min(1),
  env: z.record(z.string()).optional(),
  repro: z
    .object({
      count: z.number().optional(),
      last_seen: z.string().optional(),
      workspace_hash_if_shared: z.string().optional(),
    })
    .optional(),
  transcript_tail: z.array(z.object({ text: z.string() })).optional(),
  tool_calls_tail: z.array(z.object({ text: z.string() })).optional(),
  breadcrumbs: z
    .array(
      z.object({
        ts: z.string().optional(),
        event: z.string().optional(),
        payload_summary: z.string().optional(),
      })
    )
    .optional(),
  logs: z
    .array(
      z.object({
        level: z.string().optional(),
        ts: z.string().optional(),
        message: z.string().optional(),
      })
    )
    .optional(),
  screenshot_or_diff: z.string().optional(),
})

function parseResponseJson(responseJson: unknown): ClassificationApiRecord {
  const asRecord = responseJson as Record<string, unknown>
  const outputText = asRecord.output_text

  if (typeof outputText !== "string") {
    throw new Error("Model returned no output_text")
  }

  return JSON.parse(outputText) as ClassificationApiRecord
}

async function runClassifier(userTurn: string, model: string): Promise<ClassificationApiRecord> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured")
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      input: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: userTurn },
      ],
      response_format: {
        type: "json_schema",
        json_schema: CLASSIFICATION_SCHEMA,
      },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`OpenAI error: ${response.status} ${errorBody}`)
  }

  const payload = (await response.json()) as unknown
  return parseResponseJson(payload)
}

function applyHardReviewRules(classification: ClassificationApiRecord, reportText: string): ClassificationApiRecord {
  const mergedReasons = new Set(classification.review_reasons)
  let needsHumanReview = classification.needs_human_review

  const mentionSensitive = /data loss|secret|billing|customer/i.test(reportText)

  if (classification.confidence < 0.7) {
    needsHumanReview = true
    mergedReasons.add("confidence_below_threshold")
  }
  if (classification.severity === "critical") {
    needsHumanReview = true
    mergedReasons.add("critical_severity")
  }
  if (classification.category === "safety-policy") {
    needsHumanReview = true
    mergedReasons.add("safety_policy_category")
  }
  if (mentionSensitive) {
    needsHumanReview = true
    mergedReasons.add("sensitive_report_content")
  }

  return {
    ...classification,
    needs_human_review: needsHumanReview,
    review_reasons: [...mergedReasons].slice(0, 4),
  }
}

export async function POST(request: Request) {
  try {
    const json = await request.json()
    const parsed = classifyInputSchema.safeParse(json)

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 })
    }

    const userTurn = buildClassificationUserTurn(parsed.data)
    const smallModel = process.env.CLASSIFIER_MODEL_SMALL ?? "gpt-5-mini"
    const largeModel = process.env.CLASSIFIER_MODEL_LARGE ?? "gpt-5"

    let classification = await runClassifier(userTurn, smallModel)
    let modelUsed = smallModel
    let retriedWithLargeModel = false

    if (classification.confidence < 0.7) {
      classification = await runClassifier(userTurn, largeModel)
      modelUsed = largeModel
      retriedWithLargeModel = true
    }

    const enumValidation = validateEnumFields(classification)
    if (enumValidation) {
      return NextResponse.json(
        {
          error: `Invalid enum for ${enumValidation.field}`,
          valid_options: enumValidation.valid,
        },
        { status: 400 }
      )
    }

    if (!evidenceQuotesAreSubstrings(classification, userTurn)) {
      return NextResponse.json(
        {
          error: "Invalid evidence_quotes",
          message: "Every evidence quote must be an exact substring of the request payload",
        },
        { status: 400 }
      )
    }

    const hardened = applyHardReviewRules(classification, parsed.data.report_text)
    const dbRecord = toDbRecord(hardened, parsed.data.report_text)

    if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createAdminClient()
      const { error } = await supabase.from("bug_report_classifications").insert(dbRecord)
      if (error) {
        console.error("bug_report_classifications insert failed", error)
      }
    }

    return NextResponse.json({
      classification: hardened,
      meta: {
        model_used: modelUsed,
        retried_with_large_model: retriedWithLargeModel,
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Classification failed",
        detail: error instanceof Error ? error.message : "unknown_error",
      },
      { status: 500 }
    )
  }
}
