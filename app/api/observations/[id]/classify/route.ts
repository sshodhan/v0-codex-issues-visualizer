import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { extractBugFingerprint, computeCompoundKey } from "@/lib/scrapers/bug-fingerprint"
import {
  classifyReport,
  ClassificationValidationError,
  synthesizeObservationReportText,
} from "@/lib/classification/pipeline"

// POST /api/observations/:id/classify
//
// On-demand LLM classification for a single observation. Most reports
// already get a classification written by the scraper's post-batch
// pipeline (lib/classification/pipeline.ts → processObservationClassificationQueue).
// This endpoint exists for three UX needs:
//
//   1. Re-run the classifier from the SignalLayers panel if the automated
//      pass hadn't reached this observation yet (e.g. backfill lag).
//   2. Let a user force an LLM layer on an older observation whose regex
//      fingerprint alone isn't enough to differentiate it.
//   3. Refresh the denormalized llm_subcategory / llm_primary_tag fields
//      on the bug_fingerprint row so the SignalLayers panel and the
//      compound cluster-key label pick them up without a second join.
//
// Response is intentionally layered:
//   { regex: BugFingerprint, llm: Classification, compound_key: string }
// so the SignalLayers UI can render each pass distinctly. The canonical
// LLM row is written to `classifications` by classifyReport; the regex
// fingerprint row in `bug_fingerprints` is written during ingest and is
// not updated here (its columns only carry deterministic signals).

const paramsSchema = z.object({ id: z.string().uuid() })

/**
 * GET /api/observations/:id/classify
 *
 * Read-only companion to POST. Returns the regex fingerprint (recomputed
 * from title + body — deterministic, free) plus the most recent LLM
 * classification already persisted for this observation. No model call.
 * SignalLayers uses this to render the layered view without paying for a
 * new gpt-5-mini roundtrip on every row expand.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params
  const parsed = paramsSchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid observation id" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: row } = await supabase
    .from("mv_observation_current")
    .select("observation_id, title, content")
    .eq("observation_id", parsed.data.id)
    .maybeSingle()
  if (!row) {
    return NextResponse.json({ error: "Observation not found" }, { status: 404 })
  }

  const regex = extractBugFingerprint({ title: row.title, content: row.content ?? null })

  const { data: existingClassification } = await supabase
    .from("classifications")
    .select(
      "id, category, subcategory, severity, reproducibility, impact, confidence, summary, root_cause_hypothesis, suggested_fix, tags, evidence_quotes, model_used, retried_with_large_model, created_at",
    )
    .eq("observation_id", parsed.data.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    regex,
    llm: existingClassification
      ? {
          subcategory: existingClassification.subcategory,
          category: existingClassification.category,
          severity: existingClassification.severity,
          reproducibility: existingClassification.reproducibility,
          impact: existingClassification.impact,
          confidence: existingClassification.confidence,
          summary: existingClassification.summary,
          root_cause_hypothesis: existingClassification.root_cause_hypothesis,
          suggested_fix: existingClassification.suggested_fix,
          tags: existingClassification.tags,
          evidence_quotes: existingClassification.evidence_quotes,
          model_used: existingClassification.model_used,
          retried_with_large_model: existingClassification.retried_with_large_model,
          classification_id: existingClassification.id,
          classified_at: existingClassification.created_at,
        }
      : null,
    compound_key: (await computeCompoundKey(supabase as any, parsed.data.id)) ?? null,
  })
}

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params
  const parsed = paramsSchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid observation id" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: row, error: fetchError } = await supabase
    .from("mv_observation_current")
    .select("observation_id, title, content, url, source_id")
    .eq("observation_id", parsed.data.id)
    .maybeSingle()

  if (fetchError) {
    return NextResponse.json({ error: "Lookup failed", detail: fetchError.message }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: "Observation not found" }, { status: 404 })
  }

  const { data: sourceRow } = await supabase
    .from("sources")
    .select("slug")
    .eq("id", row.source_id)
    .maybeSingle()

  const regex = extractBugFingerprint({ title: row.title, content: row.content ?? null })

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        error: "Classifier not configured",
        message: "OPENAI_API_KEY is not set on the server.",
        regex,
      },
      { status: 503 },
    )
  }

  const reportText = synthesizeObservationReportText({
    title: row.title,
    content: row.content ?? null,
    url: row.url ?? null,
    sourceSlug: sourceRow?.slug ?? null,
  })
  if (!reportText.trim()) {
    return NextResponse.json({ error: "Observation has no text to classify" }, { status: 400 })
  }

  const adminAvailable = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
  const admin = adminAvailable ? createAdminClient() : null

  let result
  try {
    // classifyReport owns validation, escalation, hard review rules, and
    // the write to `classifications`. We reuse it rather than replicate.
    // Thread regex-derived env/repro into the classifier so the user-turn
    // payload carries structured context beyond title+body. The classifier
    // schema already accepts both fields (see classifyInputSchema in
    // lib/classification/pipeline.ts); we are enriching the prompt, not
    // changing the contract.
    const env: Record<string, string> = {}
    if (regex.cli_version) env.cli_version = regex.cli_version
    if (regex.os) env.os = regex.os
    if (regex.shell) env.shell = regex.shell
    if (regex.editor) env.editor = regex.editor
    if (regex.model_id) env.model_id = regex.model_id
    result = await classifyReport(
      {
        report_text: reportText,
        observation_id: parsed.data.id,
        env: Object.keys(env).length > 0 ? env : undefined,
        repro: regex.repro_markers > 0 ? { count: regex.repro_markers } : undefined,
      },
      { supabase: admin },
    )
  } catch (error) {
    if (error instanceof ClassificationValidationError) {
      return NextResponse.json(
        { error: "Classification rejected", detail: error.message, regex },
        { status: error.status },
      )
    }
    return NextResponse.json(
      {
        error: "Classifier failed",
        detail: error instanceof Error ? error.message : "unknown_error",
        regex,
      },
      { status: 502 },
    )
  }

  // `classifyReport` already wrote the LLM row to `classifications`
  // via the admin client (the source of truth). We do not denormalize
  // those values onto `bug_fingerprints` — mv_observation_current joins
  // `classifications` directly, so dashboards pick up the new
  // subcategory / tags / etc. on the next materialized-view refresh.
  // The compound-key label is pure regex for the same reason; we read
  // it through `computeCompoundKey` so there's a single read-time
  // source of truth (outcome E).
  const compoundKey = (await computeCompoundKey(supabase as any, parsed.data.id)) ?? null

  return NextResponse.json({
    regex,
    llm: {
      subcategory: result.classification.subcategory,
      category: result.classification.category,
      severity: result.classification.severity,
      reproducibility: result.classification.reproducibility,
      impact: result.classification.impact,
      confidence: result.classification.confidence,
      summary: result.classification.summary,
      root_cause_hypothesis: result.classification.root_cause_hypothesis,
      suggested_fix: result.classification.suggested_fix,
      tags: result.classification.tags,
      evidence_quotes: result.classification.evidence_quotes,
      model_used: result.meta.model_used,
      retried_with_large_model: result.meta.retried_with_large_model,
      classification_id: result.id,
    },
    compound_key: compoundKey,
  })
}
