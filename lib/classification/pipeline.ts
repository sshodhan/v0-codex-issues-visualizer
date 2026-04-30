import { z } from "zod"
import type { createAdminClient } from "@/lib/supabase/admin"
import { toClassificationPayload, type ClassificationApiRecord } from "@/lib/classification/mapping"
import { buildClassificationUserTurn } from "@/lib/classification/report-summary"
import { evidenceQuotesAreSubstrings, sanitizeEvidenceQuotes, validateEnumFields } from "@/lib/classification/schema"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"
import { extractResponsesOutputText, requestClassifierResponse } from "@/lib/classification/openai-responses"
import { recordClassification } from "@/lib/storage/derivations"
import { recordProcessingEvent } from "@/lib/storage/processing-events"
import { computeCompoundKey, extractBugFingerprint, type BugFingerprint } from "@/lib/scrapers/bug-fingerprint"
import {
  synthesizeObservationReportText,
  type ClassificationCandidate,
} from "@/lib/classification/candidate"

// Re-exported so existing call sites (lib/scrapers/index.ts,
// app/api/observations/[id]/classify/route.ts, etc.) keep importing
// from "@/lib/classification/pipeline" unchanged. The definitions live
// in ./candidate.ts so backfill-candidates.ts and its node:test suite
// can import them without dragging in the rest of this file's `@/*`
// dependency graph.
export { synthesizeObservationReportText }
export type { ClassificationCandidate }

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
  const outputText = extractResponsesOutputText(responseJson)

  if (typeof outputText !== "string") {
    throw new Error("Model returned no parseable text output")
  }

  return JSON.parse(outputText) as ClassificationApiRecord
}

async function runClassifier(userTurn: string, model: string): Promise<ClassificationApiRecord> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured")
  }

  const payload = await requestClassifierResponse(apiKey, userTurn, model)
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
  if (classification.category === "autonomy_safety_violation") {
    needsHumanReview = true
    mergedReasons.add("autonomy_safety_violation_category")
  }
  if (mentionSensitive) {
    needsHumanReview = true
    mergedReasons.add("sensitive_report_content")
  }
  if (!evidenceQuotesAreSubstrings(classification, reportText)) {
    needsHumanReview = true
    mergedReasons.add("evidence_quotes_sanitized")
  }

  return {
    ...classification,
    evidence_quotes: sanitizeEvidenceQuotes(classification, reportText),
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
  if (supabase && observationId) {
    await recordProcessingEvent(supabase, {
      observationId,
      stage: "classification",
      status: "attempted",
      algorithmVersionModel: smallModel,
      detail: { pass: "small" },
    })
  }
  let modelUsed = smallModel
  let retriedWithLargeModel = false
  let smallModelClassificationId: string | null = null

  if (classification.confidence < 0.7) {
    if (supabase && observationId) {
      await recordProcessingEvent(supabase, {
        observationId,
        stage: "classification",
        status: "escalated",
        algorithmVersionModel: `${smallModel}->${largeModel}`,
        detail: { reason: "confidence_below_threshold", confidence: classification.confidence },
      })
    }
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
    if (supabase && observationId) {
      await recordProcessingEvent(supabase, {
        observationId,
        stage: "classification",
        status: "attempted",
        algorithmVersionModel: largeModel,
        detail: { pass: "large" },
      })
    }
    modelUsed = largeModel
    retriedWithLargeModel = true
  }

  const enumValidation = validateEnumFields(classification)
  if (enumValidation) {
    throw new ClassificationValidationError(
      `Invalid enum for ${enumValidation.field}; valid: ${enumValidation.valid.join(", ")}`,
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
    if (observationId) {
      await recordProcessingEvent(supabase, {
        observationId,
        stage: "classification",
        status: "completed",
        algorithmVersionModel: modelUsed,
        detail: {
          classification_id: classificationId,
          retried_with_large_model: retriedWithLargeModel,
          needs_human_review: hardened.needs_human_review,
        },
      })
    }
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
      await recordProcessingEvent(supabase, {
        observationId: candidate.observationId,
        stage: "classification",
        status: "failed",
        algorithmVersionModel: process.env.CLASSIFIER_MODEL_SMALL ?? "gpt-5-mini",
        detail: { reason },
      })
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

// Shared orchestration for the on-demand single-observation classify path.
// app/api/observations/[id]/classify (POST) and the unified
// /rerun?stage=classification entry both produce identical work — fetch
// the observation row, resolve the source slug, derive regex env hints,
// synthesize report text, call classifyReport, and recompute the compound
// cluster-key label. This helper centralises that flow so the routes are
// just HTTP shapers; the tagged outcome lets each route map a failure
// to the appropriate status code without re-implementing the branching.
export interface ObservationLookupReader {
  from: (table: string) => any
}

export interface RunClassificationDeps {
  supabase: ObservationLookupReader
  admin: AdminClient | null
}

export type RunClassificationOutcome =
  | {
      ok: true
      regex: BugFingerprint
      result: Awaited<ReturnType<typeof classifyReport>>
      compoundKey: string | null
    }
  | { ok: false; status: 404; code: "not_found" }
  | { ok: false; status: 500; code: "lookup_failed"; detail: string }
  | { ok: false; status: 503; code: "missing_api_key" }
  | { ok: false; status: 400; code: "no_text"; regex: BugFingerprint }
  | { ok: false; status: 422; code: "validation_error"; detail: string; regex: BugFingerprint }
  | { ok: false; status: 502; code: "classifier_error"; detail: string; regex: BugFingerprint }

export async function runClassificationForObservation(
  observationId: string,
  deps: RunClassificationDeps,
): Promise<RunClassificationOutcome> {
  const { supabase, admin } = deps

  const { data: row, error: fetchError } = await supabase
    .from("mv_observation_current")
    .select("observation_id, title, content, url, source_id")
    .eq("observation_id", observationId)
    .maybeSingle()

  if (fetchError) {
    return { ok: false, status: 500, code: "lookup_failed", detail: fetchError.message }
  }
  if (!row) {
    return { ok: false, status: 404, code: "not_found" }
  }

  const regex = extractBugFingerprint({ title: row.title, content: row.content ?? null })

  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, status: 503, code: "missing_api_key" }
  }

  const { data: sourceRow } = await supabase
    .from("sources")
    .select("slug")
    .eq("id", row.source_id)
    .maybeSingle()

  const reportText = synthesizeObservationReportText({
    title: row.title,
    content: row.content ?? null,
    url: row.url ?? null,
    sourceSlug: sourceRow?.slug ?? null,
  })
  if (!reportText.trim()) {
    return { ok: false, status: 400, code: "no_text", regex }
  }

  // Thread regex-derived env/repro into the classifier so the user-turn
  // payload carries structured context beyond title+body. classifyReport
  // owns validation, escalation, hard-review rules, and the write to
  // `classifications`; we are only enriching the prompt here.
  const env: Record<string, string> = {}
  if (regex.cli_version) env.cli_version = regex.cli_version
  if (regex.os) env.os = regex.os
  if (regex.shell) env.shell = regex.shell
  if (regex.editor) env.editor = regex.editor
  if (regex.model_id) env.model_id = regex.model_id

  let result: Awaited<ReturnType<typeof classifyReport>>
  try {
    result = await classifyReport(
      {
        report_text: reportText,
        observation_id: observationId,
        env: Object.keys(env).length > 0 ? env : undefined,
        repro: regex.repro_markers > 0 ? { count: regex.repro_markers } : undefined,
      },
      { supabase: admin },
    )
  } catch (error) {
    if (error instanceof ClassificationValidationError) {
      return {
        ok: false,
        status: error.status as 422,
        code: "validation_error",
        detail: error.message,
        regex,
      }
    }
    return {
      ok: false,
      status: 502,
      code: "classifier_error",
      detail: error instanceof Error ? error.message : "unknown_error",
      regex,
    }
  }

  // Read-time compound-key derivation (same source of truth as the
  // SignalLayers panel; outcome E in docs/ARCHITECTURE.md).
  const compoundKey = (await computeCompoundKey(supabase as any, observationId)) ?? null

  return { ok: true, regex, result, compoundKey }
}
