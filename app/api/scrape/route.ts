import { NextResponse } from "next/server"
import { runAllScrapers } from "@/lib/scrapers"

export const maxDuration = 60 // Allow up to 60 seconds for scraping

export async function POST() {
  try {
    const result = await runAllScrapers()

    return NextResponse.json({
      success: true,
      message: `Scraped ${result.total} issues, added/updated ${result.added}`,
      ...result,
    })
  } catch (error) {
    console.error("Scrape error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
