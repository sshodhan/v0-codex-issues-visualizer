import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { getJob } from "@/lib/admin/classification-jobs"
import { logServerError } from "@/lib/error-tracking/server-logger"

// GET /api/admin/classification-jobs/:id — read-only status poll.
// The admin panel hits this every few seconds while a job is active to
// drive the progress bar. Side-effect-free; advancing the queue is
// /:id/advance.

export const maxDuration = 30

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const { id } = await ctx.params
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 })
  }

  try {
    const supabase = createAdminClient()
    const job = await getJob(supabase, id)
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }
    return NextResponse.json({ job })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("admin-classification-jobs", "get_failed", error, { id })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
