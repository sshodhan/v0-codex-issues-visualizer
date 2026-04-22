import { NextRequest, NextResponse } from "next/server"
import { runAllScrapers } from "@/lib/scrapers"

export const maxDuration = 60

// This route is called by Vercel Cron.
//
// Auth posture matches /api/cron/classify-backfill: fail-closed in
// production when CRON_SECRET is unset (503), enforce Bearer token when
// set, allow unauthenticated in non-prod for local development. Without
// the prod fail-closed, a missing env var would silently leave this
// endpoint open to anyone hitting the URL.
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
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    )
  }

  try {
    const result = await runAllScrapers()
    return NextResponse.json({
      success: true,
      message: `Cron job completed: scraped ${result.total} issues`,
      ...result,
    })
  } catch (error) {
    console.error("Cron scrape error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
