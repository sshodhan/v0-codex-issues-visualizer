import { NextResponse } from "next/server"
import { sentimentAnalytics } from "@/lib/analysis/data"

export const dynamic = "force-static"

export function GET() {
  return NextResponse.json(sentimentAnalytics())
}
