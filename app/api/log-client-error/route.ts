import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    const safe = {
      errorType: String(body?.errorType ?? "Unknown"),
      message: String(body?.message ?? "No message"),
      stack: body?.stack ? String(body.stack) : undefined,
      url: body?.url ? String(body.url) : undefined,
      userAgent: body?.userAgent ? String(body.userAgent) : undefined,
      timestamp: body?.timestamp ? String(body.timestamp) : new Date().toISOString(),
      additionalInfo:
        body?.additionalInfo && typeof body.additionalInfo === "object" ? body.additionalInfo : undefined,
    }

    console.error("═".repeat(54))
    console.error("🚨 CLIENT-SIDE ERROR CAPTURED")
    console.error("═".repeat(54))
    console.error(safe)

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[log-client-error] failed", error)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
