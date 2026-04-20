import { NextResponse } from "next/server"
import { TIMELINE, crisisTrough, recoveryPeak } from "@/lib/analysis/data"

export const dynamic = "force-static"

export function GET() {
  return NextResponse.json({
    points: TIMELINE,
    peak_crisis: crisisTrough(),
    peak_recovery: recoveryPeak(),
  })
}
