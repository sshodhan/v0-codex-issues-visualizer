import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import {
  classifyReport,
  ClassificationValidationError,
  synthesizeObservationReportText,
} from "@/lib/classification/pipeline"
import { extractBugFingerprint, computeCompoundKey } from "@/lib/scrapers/bug-fingerprint"
import { buildEmbeddingInputText } from "@/lib/storage/semantic-cluster-core"
import { createEmbedding, SEMANTIC_EMBEDDING_MODEL } from "@/lib/storage/semantic-clusters"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"
import { recordProcessingEvent } from "@/lib/storage/processing-events"

// POST /api/observations/:id/rerun
//
// Single-observation, on-demand stage re-run for the trace page. We only
// expose stages where re-running for a single row makes sense and where
// the existing storage path supports an upsert / append-row write:
//
//   - classification: delegates to classifyReport (same path the existing
//     POST /api/observations/:id/classify route uses). Appends a new row
//     to `classifications` with prior_classification_id pointing at the
//     previous head — preserving the immutable lineage chain.
//   - embedding: re-calls the OpenAI embeddings API and upserts via
//     record_observation_embedding (the RPC is `on conflict do update`,
//     scripts/012_semantic_clustering.sql). This is the only stage where
//     a true overwrite is correct: the same algorithm_version + model
//     should produce a deterministic input → vector mapping.
//
// Stages we intentionally do NOT expose here:
//   - capture: source data; not recomputable.
//   - fingerprint, category: deterministic regex; same algorithm_version
//     produces an identical result. The RPCs are `on conflict do nothing`,
//     so a re-run would be a no-op. To force fresh rows, bump
//     CURRENT_VERSIONS in lib/storage/algorithm-versions.ts and run the
//     batch backfill.
//   - clustering: must be coordinated across the whole batch (semantic
//     similarity needs neighbours). See app/api/admin/cluster.

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z.object({
  stage: z.enum(["classification", "embedding"]),
})

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params
  const parsedParams = paramsSchema.safeParse(params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid observation id" }, { status: 400 })
  }

  let parsedBody: z.infer<typeof bodySchema>
  try {
    const json = await request.json()
    const result = bodySchema.safeParse(json)
    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid body", detail: result.error.message },
        { status: 400 },
      )
    }
    parsedBody = result.data
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 })
  }

  const observationId = parsedParams.data.id
  const supabase = await createClient()

  const { data: row, error: fetchError } = await supabase
    .from("mv_observation_current")
    .select("observation_id, title, content, url, source_id")
    .eq("observation_id", observationId)
    .maybeSingle()

  if (fetchError) {
    return NextResponse.json({ error: "Lookup failed", detail: fetchError.message }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: "Observation not found" }, { status: 404 })
  }

  const adminAvailable = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
  const admin = adminAvailable ? createAdminClient() : null

  if (parsedBody.stage === "classification") {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "Classifier not configured", message: "OPENAI_API_KEY is not set on the server." },
        { status: 503 },
      )
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
      return NextResponse.json({ error: "Observation has no text to classify" }, { status: 400 })
    }

    const regex = extractBugFingerprint({ title: row.title, content: row.content ?? null })
    const env: Record<string, string> = {}
    if (regex.cli_version) env.cli_version = regex.cli_version
    if (regex.os) env.os = regex.os
    if (regex.shell) env.shell = regex.shell
    if (regex.editor) env.editor = regex.editor
    if (regex.model_id) env.model_id = regex.model_id

    try {
      const result = await classifyReport(
        {
          report_text: reportText,
          observation_id: observationId,
          env: Object.keys(env).length > 0 ? env : undefined,
          repro: regex.repro_markers > 0 ? { count: regex.repro_markers } : undefined,
        },
        { supabase: admin },
      )
      const compoundKey = (await computeCompoundKey(supabase as any, observationId)) ?? null
      return NextResponse.json({
        stage: "classification",
        ok: true,
        classification_id: result.id,
        model_used: result.meta.model_used,
        retried_with_large_model: result.meta.retried_with_large_model,
        compound_key: compoundKey,
      })
    } catch (error) {
      if (error instanceof ClassificationValidationError) {
        return NextResponse.json(
          { error: "Classification rejected", detail: error.message },
          { status: error.status },
        )
      }
      return NextResponse.json(
        {
          error: "Classifier failed",
          detail: error instanceof Error ? error.message : "unknown_error",
        },
        { status: 502 },
      )
    }
  }

  // Embedding re-run.
  if (!admin) {
    return NextResponse.json(
      {
        error: "Embedding re-run not available",
        message: "Service role key is not configured on the server.",
      },
      { status: 503 },
    )
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Embeddings not configured", message: "OPENAI_API_KEY is not set on the server." },
      { status: 503 },
    )
  }

  const input = buildEmbeddingInputText(row.title, row.content ?? null)
  const vector = await createEmbedding(input)
  if (!vector) {
    await recordProcessingEvent(admin, {
      observationId,
      stage: "embedding",
      status: "failed",
      algorithmVersionModel: `${CURRENT_VERSIONS.observation_embedding}:${SEMANTIC_EMBEDDING_MODEL}`,
      detail: { reason: "embedding_api_failed", trigger: "manual_rerun" },
    })
    return NextResponse.json(
      { error: "Embedding API call failed" },
      { status: 502 },
    )
  }

  const { error: rpcError } = await admin.rpc("record_observation_embedding", {
    obs_id: observationId,
    ver: CURRENT_VERSIONS.observation_embedding,
    model_name: SEMANTIC_EMBEDDING_MODEL,
    dims: vector.length,
    input_text: input,
    vec: vector as any,
  })
  if (rpcError) {
    return NextResponse.json(
      { error: "Failed to persist embedding", detail: rpcError.message },
      { status: 500 },
    )
  }
  await recordProcessingEvent(admin, {
    observationId,
    stage: "embedding",
    status: "completed",
    algorithmVersionModel: `${CURRENT_VERSIONS.observation_embedding}:${SEMANTIC_EMBEDDING_MODEL}`,
    detail: { dimensions: vector.length, trigger: "manual_rerun" },
  })

  return NextResponse.json({
    stage: "embedding",
    ok: true,
    model: SEMANTIC_EMBEDDING_MODEL,
    algorithm_version: CURRENT_VERSIONS.observation_embedding,
    dimensions: vector.length,
  })
}
