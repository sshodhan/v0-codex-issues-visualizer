import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { runClassificationForObservation } from "@/lib/classification/pipeline"
import { recomputeObservationEmbedding } from "@/lib/storage/semantic-clusters"

// POST /api/observations/:id/rerun
//
// Single-observation, on-demand stage re-run for the trace page. We only
// expose stages where re-running for a single row makes sense and where
// the existing storage path supports an upsert / append-row write:
//
//   - classification: delegates to runClassificationForObservation
//     (shared with /api/observations/:id/classify POST). Appends a new
//     row to `classifications` with prior_classification_id pointing at
//     the previous head — preserving the immutable lineage chain.
//   - embedding: delegates to recomputeObservationEmbedding (shared with
//     ensureEmbedding in lib/storage/semantic-clusters.ts). The RPC is
//     on-conflict-do-update so the same algorithm_version + model
//     deterministically overwrites the prior vector.
//
// Stages we intentionally do NOT expose here:
//   - capture: source data; not recomputable.
//   - fingerprint, category: deterministic regex; same algorithm_version
//     produces an identical result. The RPCs are on-conflict-do-nothing,
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
  const adminAvailable = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
  const admin = adminAvailable ? createAdminClient() : null

  if (parsedBody.stage === "classification") {
    const outcome = await runClassificationForObservation(observationId, { supabase, admin })
    if (!outcome.ok) {
      return NextResponse.json(
        {
          error: outcome.code,
          ...(outcome.code === "validation_error" || outcome.code === "classifier_error"
            ? { detail: outcome.detail }
            : {}),
          ...(outcome.code === "lookup_failed" ? { detail: outcome.detail } : {}),
        },
        { status: outcome.status },
      )
    }
    return NextResponse.json({
      stage: "classification",
      ok: true,
      classification_id: outcome.result.id,
      model_used: outcome.result.meta.model_used,
      retried_with_large_model: outcome.result.meta.retried_with_large_model,
      compound_key: outcome.compoundKey,
    })
  }

  // Embedding re-run.
  if (!admin) {
    return NextResponse.json(
      {
        error: "missing_service_role",
        message: "Service role key is not configured on the server.",
      },
      { status: 503 },
    )
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "missing_api_key", message: "OPENAI_API_KEY is not set on the server." },
      { status: 503 },
    )
  }

  const { data: row, error: fetchError } = await supabase
    .from("mv_observation_current")
    .select("observation_id, title, content")
    .eq("observation_id", observationId)
    .maybeSingle()
  if (fetchError) {
    return NextResponse.json({ error: "lookup_failed", detail: fetchError.message }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  const outcome = await recomputeObservationEmbedding(
    admin,
    { id: observationId, title: row.title, content: row.content ?? null },
    { trigger: "manual_rerun" },
  )
  if (!outcome.ok) {
    return NextResponse.json(
      { error: "embedding_failed", detail: outcome.reason },
      { status: 502 },
    )
  }
  return NextResponse.json({
    stage: "embedding",
    ok: true,
    model: outcome.model,
    algorithm_version: outcome.algorithmVersion,
    dimensions: outcome.dimensions,
  })
}
