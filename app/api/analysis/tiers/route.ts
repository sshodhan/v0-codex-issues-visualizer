import { NextResponse } from "next/server"
import { tierBreakdown } from "@/lib/analysis/data"

export const dynamic = "force-static"

export function GET() {
  return NextResponse.json(tierBreakdown())
}
