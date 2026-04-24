import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"

// Client-side log ingestion. Originally error-only (hence the route
// name); now also accepts `level: "info"` events that admin panels use
// to record each classify-backfill lifecycle step with full context
// (batch size, threshold, window, outcome, duration). Both paths
// print JSON so Vercel log drains can be filtered by level.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const level = body?.level === "info" ? "info" : "error"

    const safe = {
      level,
      errorType: String(body?.errorType ?? "Unknown"),
      message: String(body?.message ?? "No message"),
      stack: body?.stack ? String(body.stack) : undefined,
      url: body?.url ? String(body.url) : undefined,
      userAgent: body?.userAgent ? String(body.userAgent) : undefined,
      timestamp: body?.timestamp ? String(body.timestamp) : new Date().toISOString(),
      additionalInfo:
        body?.additionalInfo && typeof body.additionalInfo === "object" ? body.additionalInfo : undefined,
    }

    if (level === "info") {
      console.log("═".repeat(54))
      console.log(`📋 CLIENT EVENT: ${safe.errorType}`)
      console.log("═".repeat(54))
      console.log(safe)
    } else {
      console.error("═".repeat(54))
      console.error("🚨 CLIENT-SIDE ERROR CAPTURED")
      console.error("═".repeat(54))
      console.error(safe)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[log-client-error] failed", error)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
