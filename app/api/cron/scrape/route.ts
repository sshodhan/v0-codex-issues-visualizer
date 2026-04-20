import { NextRequest, NextResponse } from "next/server"
import { runAllScrapers } from "@/lib/scrapers"

export const maxDuration = 60

// This route is called by Vercel Cron
export async function GET(request: NextRequest) {
  // Verify cron secret in production
  const authHeader = request.headers.get("authorization")
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
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
