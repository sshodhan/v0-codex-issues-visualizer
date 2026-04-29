import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { claimNextJob } from "@/lib/admin/classification-jobs"
import { processOneBatch } from "@/lib/admin/classification-jobs-worker"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"

// Vercel cron tick that drains the classification_jobs queue.
//
// On Pro plans this is wired to */2 minutes in vercel.json so a
// background job left behind by an operator (browser closed mid-loop)
// keeps making progress. On Hobby plans the cron schedule still works
// but only daily; the panel's polling /:id/advance call is the real
// driver while the operator is in the tab.
//
// Each tick claims the oldest queued job (or a stale-running one whose
// heartbeat hasn't refreshed in ~5min) and processes batches in a loop
// until the function-duration budget runs out. Bounded iterations as a
// belt-and-suspenders against a runaway loop.

export const maxDuration = 60

const MAX_ITERATIONS = 30
// Stop the loop with this many seconds of headroom under maxDuration so
// the function doesn't 504 mid-batch (which would leave the heartbeat
// stale and require a future tick to reclaim).
const BUDGET_HEADROOM_MS = 12_000

export async function GET(request: NextRequest) {
  const isProduction =
    process.env.VERCEL_ENV === "production" ||
    (!process.env.VERCEL_ENV && process.env.NODE_ENV === "production")
  const expectedSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")

  if (expectedSecret) {
    if (authHeader !== `Bearer ${expectedSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  } else if (isProduction) {
    // Mirror the classify-backfill cron's fail-closed posture; a missing
    // secret in production is misconfiguration, not "open the route".
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    )
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Classifier not configured", message: "OPENAI_API_KEY missing" },
      { status: 503 },
    )
  }

  const supabase = createAdminClient()
  const startedAt = Date.now()
  const summary = {
    iterations: 0,
    jobsTouched: 0,
    processed: 0,
    classified: 0,
    failed: 0,
  }

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const elapsed = Date.now() - startedAt
      if (elapsed > maxDuration * 1000 - BUDGET_HEADROOM_MS) {
        // Out of budget for this tick; the next tick will pick up where
        // we left off (heartbeat is fresh, so it won't be reclaimed
        // immediately).
        logServer({
          component: "cron-classification-jobs",
          event: "budget_exhausted",
          level: "info",
          data: { elapsed, ...summary },
        })
        break
      }

      const job = await claimNextJob(supabase)
      if (!job) {
        // Queue idle — exit early so the function returns instead of
        // sitting on the cron timeout doing nothing.
        break
      }

      summary.iterations++
      summary.jobsTouched++

      const outcome = await processOneBatch(supabase, job)
      summary.processed += outcome.processedThisBatch
      summary.classified += outcome.classifiedThisBatch
      summary.failed += outcome.failedThisBatch

      if (outcome.fatalError) {
        // processOneBatch already finalized the job as 'failed'; loop
        // around to drain any siblings.
        continue
      }

      if (!outcome.done) {
        // Same job has more batches; loop around. claimNextJob will pick
        // it up again because queued jobs sort first and a still-running
        // job has a fresh heartbeat that won't trip the stale fence.
        // We re-claim here (rather than calling processOneBatch in a
        // tight loop) so a higher-priority queued job can preempt a
        // long-running one if an operator enqueues it mid-tick.
        continue
      }
    }

    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logServerError("cron-classification-jobs", "tick_failed", error, summary)
    return NextResponse.json({ error: message, summary }, { status: 500 })
  }
}
