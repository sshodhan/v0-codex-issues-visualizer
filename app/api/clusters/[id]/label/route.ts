import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { runClusterLabelBackfill } from "@/lib/storage/run-cluster-label-backfill"

// POST /api/clusters/:id/label
//
// Single-cluster trigger for the deterministic cluster-label generator.
// Same orchestrator (lib/storage/run-cluster-label-backfill.ts) the
// admin batch route uses — we just narrow the candidate set to a
// single cluster via the new `clusterIds` filter, and optionally bypass
// the "label missing or weak" candidate filter via `force`.
//
// Why a separate route from /api/admin/cluster-label-backfill:
//   - The admin route is gated by ADMIN_SECRET and audited via
//     scrape_logs because it's a fleet-wide operation.
//   - This route is the per-cluster reviewer trigger from the trace
//     page (parallel to /api/observations/[id]/rerun) — same idea, no
//     admin secret, only ever touches one cluster's row.
//
// The labeller is deterministic: it composes a label from cluster
// contents (Topic + canonical title + recurring error code) via
// composeDeterministicLabel and writes via the set_cluster_label RPC.
// No OpenAI call. The LLM cluster-name generator only runs during the
// batch clustering job (lib/storage/semantic-clusters.ts:608).

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .default({})

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params
  const parsedParams = paramsSchema.safeParse(params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid cluster id" }, { status: 400 })
  }

  let body: z.infer<typeof bodySchema> = {}
  try {
    const json = await request.json().catch(() => ({}))
    const result = bodySchema.safeParse(json)
    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid body", detail: result.error.message },
        { status: 400 },
      )
    }
    body = result.data
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 })
  }

  const adminAvailable = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
  if (!adminAvailable) {
    return NextResponse.json(
      {
        error: "missing_service_role",
        message: "Service role key is not configured on the server.",
      },
      { status: 503 },
    )
  }
  const admin = createAdminClient()

  try {
    const { summary, entries } = await runClusterLabelBackfill(admin, {
      apply: true,
      clusterIds: [parsedParams.data.id],
      force: body.force === true,
    })
    const entry = entries[0] ?? null

    // candidate_clusters === 0 means the cluster did not match the
    // candidate filter (label exists with strong confidence). Surface
    // this distinctly so the UI can suggest passing { force: true }.
    if (summary.candidate_clusters === 0) {
      return NextResponse.json({
        ok: true,
        relabelled: false,
        reason: "cluster_already_labelled",
        summary,
      })
    }

    if (summary.rpc_failures > 0 || !entry) {
      return NextResponse.json(
        { error: "set_cluster_label_failed", summary },
        { status: 502 },
      )
    }

    return NextResponse.json({
      ok: true,
      relabelled: true,
      cluster_id: entry.cluster_id,
      label: entry.new_label,
      confidence: entry.new_confidence,
      model: entry.new_model,
      summary,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: "cluster_label_failed",
        detail: error instanceof Error ? error.message : "unknown_error",
      },
      { status: 500 },
    )
  }
}
