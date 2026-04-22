import { z } from "zod"
import type { createAdminClient } from "@/lib/supabase/admin"
import { toClassificationPayload, type ClassificationApiRecord } from "@/lib/classification/mapping"
import { CLASSIFIER_SYSTEM_PROMPT } from "@/lib/classification/prompt"
import { buildClassificationUserTurn } from "@/lib/classification/report-summary"
import { CLASSIFICATION_SCHEMA, evidenceQuotesAreSubstrings, validateEnumFields } from "@/lib/classification/schema"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"
import { recordClassification } from "@/lib/storage/derivations"

type AdminClient = ReturnType<typeof createAdminClient>

export const classifyInputSchema = z.object({
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
  observation_id: z.string().uuid().optional(),
  source_issue_id: z.string().uuid().optional(),
  source_issue_url: z.string().url().optional(),
  source_issue_title: z.string().optional(),
  source_issue_sentiment: z.enum(["positive", "negative", "neutral"]).optional(),
})

export type ClassificationInput = z.infer<typeof classifyInputSchema>

export interface ClassificationCandidate {
  observationId: string
  title: string
  reportText: string
  // Regex-derived structured context forwarded to classifyReport's
  // user-turn builder. The classifier schema (classifyInputSchema above)
  // already accepts both fields; we are enriching the prompt payload, not
  // changing the response contract. Absent when the fingerprint extraction
  // didn't find the relevant tokens.
  env?: Record<string, string>
  repro?: {
    count?: number
    last_seen?: string
    workspace_hash_if_shared?: string
  }
}

export interface ClassificationQueueResult {
  attempted: number
  classified: number
  skipped: number
  failures: Array<{ observationId: string; title: string; reason: string }>
}

export class ClassificationValidationError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

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

export async function classifyReport(
  input: ClassificationInput,
  options: { supabase?: AdminClient | null } = {},
) {
  const userTurn = buildClassificationUserTurn(input)
  const smallModel = process.env.CLASSIFIER_MODEL_SMALL ?? "gpt-5-mini"
  const largeModel = process.env.CLASSIFIER_MODEL_LARGE ?? "gpt-5"
  const supabase = options.supabase ?? null
  const observationId = input.observation_id ?? input.source_issue_id ?? undefined

  let classification = await runClassifier(userTurn, smallModel)
  let modelUsed = smallModel
  let retriedWithLargeModel = false
  let smallModelClassificationId: string | null = null

  if (classification.confidence < 0.7) {
    if (supabase) {
      const hardenedSmall = applyHardReviewRules(classification, input.report_text)
      const smallPayload = toClassificationPayload(hardenedSmall, input.report_text, {
        observation_id: observationId,
        model_used: smallModel,
        retried_with_large_model: false,
      })
      smallModelClassificationId = await recordClassification(supabase, smallPayload)
    }

    classification = await runClassifier(userTurn, largeModel)
    modelUsed = largeModel
    retriedWithLargeModel = true
  }

  const enumValidation = validateEnumFields(classification)
  if (enumValidation) {
    throw new ClassificationValidationError(
      `Invalid enum for ${enumValidation.field}; valid: ${enumValidation.valid.join(", ")}`,
    )
  }

  if (!evidenceQuotesAreSubstrings(classification, userTurn)) {
    throw new ClassificationValidationError(
      "Invalid evidence_quotes: every evidence quote must be an exact substring",
    )
  }

  const hardened = applyHardReviewRules(classification, input.report_text)
  const payload = toClassificationPayload(hardened, input.report_text, {
    observation_id: observationId,
    prior_classification_id: smallModelClassificationId ?? undefined,
    model_used: modelUsed,
    retried_with_large_model: retriedWithLargeModel,
  })

  let classificationId: string | null = null
  if (supabase) {
    classificationId = await recordClassification(supabase, payload)
  }

  return {
    classification: hardened,
    id: classificationId,
    meta: {
      model_used: modelUsed,
      retried_with_large_model: retriedWithLargeModel,
      prior_classification_id: smallModelClassificationId,
    },
  }
}

export function synthesizeObservationReportText(input: {
  title: string
  content?: string | null
  url?: string | null
  sourceSlug?: string | null
}) {
  const lines = [
    `Observed issue from ${input.sourceSlug ?? "unknown-source"}:`,
    `Title: ${input.title}`,
  ]
  if (input.content && input.content.trim().length > 0) {
    lines.push(`Content: ${input.content.trim()}`)
  }
  if (input.url) {
    lines.push(`URL: ${input.url}`)
  }
  return lines.join("\n")
}

export async function hasExistingClassification(
  supabase: AdminClient,
  observationId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("classifications")
    .select("id")
    .eq("observation_id", observationId)
    .limit(1)

  if (error) {
    throw error
  }

  return (data ?? []).length > 0
}

export async function processObservationClassificationQueue(
  supabase: AdminClient,
  candidates: ClassificationCandidate[],
  options: { reclassifyExisting?: boolean } = {},
): Promise<ClassificationQueueResult> {
  const failures: ClassificationQueueResult["failures"] = []
  let classified = 0
  let skipped = 0

  for (const candidate of candidates) {
    try {
      if (!options.reclassifyExisting) {
        const alreadyClassified = await hasExistingClassification(supabase, candidate.observationId)
        if (alreadyClassified) {
          skipped++
          continue
        }
      }

      await classifyReport(
        {
          report_text: candidate.reportText,
          observation_id: candidate.observationId,
          env: candidate.env,
          repro: candidate.repro,
        },
        { supabase },
      )
      classified++
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push({
        observationId: candidate.observationId,
        title: candidate.title,
        reason,
      })
      logServerError("classification-pipeline", "observation_classification_failed", error, {
        observationId: candidate.observationId,
        title: candidate.title,
      })
    }
  }

  logServer({
    component: "classification-pipeline",
    event: "classification_queue_processed",
    level: failures.length > 0 ? "warn" : "info",
    data: {
      attempted: candidates.length,
      classified,
      skipped,
      failed: failures.length,
    },
  })

  return {
    attempted: candidates.length,
    classified,
    skipped,
    failures,
  }
}
