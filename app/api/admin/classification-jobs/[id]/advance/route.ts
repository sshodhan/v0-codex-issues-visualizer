import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { getJob } from "@/lib/admin/classification-jobs"
import { processOneBatch } from "@/lib/admin/classification-jobs-worker"
import { logServerError } from "@/lib/error-tracking/server-logger"

// POST /api/admin/classification-jobs/:id/advance
//
// Push one batch of work through the named job. The admin panel calls
// this opportunistically (every poll-interval if the job is still
// queued/running) so a job makes progress while the operator's browser
// is open even on Hobby plans where the cron tick can't run minutely.
//
// Idempotent: calling advance on a finished/cancelled job is a no-op
// returning the job's current state. Calling it on a job whose batch is
// already in-flight (heartbeat fresh) just refreshes the heartbeat
// because markJobRunning is idempotent.

export const maxDuration = 60

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
    const job = await getJob(supabase, id)
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    // Already finished — no work to do; return the row so the caller
    // can update its UI without a separate GET.
    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return NextResponse.json({ job, advanced: false })
    }

    const outcome = await processOneBatch(supabase, job)
    const refreshed = await getJob(supabase, id)
    return NextResponse.json({
      job: refreshed,
      advanced: true,
      outcome,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("admin-classification-jobs", "advance_failed", error, { id })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
