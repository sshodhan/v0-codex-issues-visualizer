import { NextRequest, NextResponse } from "next/server"
import { runScraper } from "@/lib/scrapers"

export const maxDuration = 60

const ALLOWED_SOURCES = new Set(["reddit", "hackernews", "github", "stackoverflow"])

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ source: string }> }
) {
  const { source } = await params

  if (!ALLOWED_SOURCES.has(source)) {
    return NextResponse.json(
      { success: false, error: `Unknown source: ${source}` },
      { status: 400 }
    )
  }

  try {
    const result = await runScraper(source)
    return NextResponse.json({
      success: result.errors.length === 0,
      message: `Scraped ${result.total} issues from ${source}, added/updated ${result.added}`,
      ...result,
    })
  } catch (error) {
    console.error(`Scrape error for ${source}:`, error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
