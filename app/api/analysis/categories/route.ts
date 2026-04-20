import { NextResponse } from "next/server"
import { CATEGORIES } from "@/lib/analysis/data"

export const dynamic = "force-static"

export function GET() {
  // Sort: tier ASC, then share_pct DESC.
  const sorted = [...CATEGORIES].sort(
    (a, b) => a.tier - b.tier || b.share_pct - a.share_pct,
  )
  return NextResponse.json(sorted)
}
