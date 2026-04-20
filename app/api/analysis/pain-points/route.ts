import { NextResponse } from "next/server"
import { painPoints } from "@/lib/analysis/data"

export const dynamic = "force-dynamic"

export function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = Number(searchParams.get("limit") ?? "5")
  return NextResponse.json(painPoints(Number.isFinite(limit) ? limit : 5))
}
