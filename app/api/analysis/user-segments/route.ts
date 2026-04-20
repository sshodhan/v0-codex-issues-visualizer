import { NextResponse } from "next/server"
import { USER_SEGMENTS } from "@/lib/analysis/data"

export const dynamic = "force-static"

export function GET() {
  return NextResponse.json(
    [...USER_SEGMENTS].sort(
      (a, b) => b.crisis_severity_percentage - a.crisis_severity_percentage,
    ),
  )
}
