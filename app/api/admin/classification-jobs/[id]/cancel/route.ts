import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { cancelJob } from "@/lib/admin/classification-jobs"
import { logServerError } from "@/lib/error-tracking/server-logger"

// POST /api/admin/classification-jobs/:id/cancel
//
// Operator-driven cancel. Idempotent — cancelling a finished job is a
// no-op. A running worker honors the cancel between batches (or
// mid-batch, between cluster items) via isJobActive checks; the
// operator therefore sees cancel latency of at most one batch.

export const maxDuration = 30

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const { id } = await ctx.params
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 })
  }

  try {
    const supabase = createAdminClient()
    const job = await cancelJob(supabase, id)
    return NextResponse.json({ job })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("admin-classification-jobs", "cancel_failed", error, { id })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
