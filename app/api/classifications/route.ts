import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  const status = searchParams.get("status")
  const category = searchParams.get("category")
  const needsHumanReview = searchParams.get("needs_human_review")
  const limit = Number.parseInt(searchParams.get("limit") || "50", 10)

  let query = supabase
    .from("bug_report_classifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (status) query = query.eq("status", status)
  if (category) query = query.eq("category", category)
  if (needsHumanReview === "true") query = query.eq("needs_human_review", true)
  if (needsHumanReview === "false") query = query.eq("needs_human_review", false)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: data || [] })
}
