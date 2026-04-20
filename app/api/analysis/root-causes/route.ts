import { NextResponse } from "next/server"
import { ROOT_CAUSES } from "@/lib/analysis/data"

export const dynamic = "force-static"

export function GET() {
  const sorted = [...ROOT_CAUSES].sort(
    (a, b) =>
      b.estimated_users_impacted_percentage - a.estimated_users_impacted_percentage,
  )
  return NextResponse.json(sorted)
}
