import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  const source = searchParams.get("source")
  const category = searchParams.get("category")
  const sentiment = searchParams.get("sentiment")
  const sortBy = searchParams.get("sortBy") || "impact_score"
  const order = searchParams.get("order") || "desc"
  const limit = parseInt(searchParams.get("limit") || "100")
  const offset = parseInt(searchParams.get("offset") || "0")

  let query = supabase
    .from("issues")
    .select(
      `
      *,
      source:sources(*),
      category:categories(*)
    `,
      { count: "exact" }
    )
    .order(sortBy, { ascending: order === "asc" })
    .range(offset, offset + limit - 1)

  if (source) {
    query = query.eq("source.slug", source)
  }
  if (category) {
    query = query.eq("category.slug", category)
  }
  if (sentiment) {
    query = query.eq("sentiment", sentiment)
  }

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, count })
}
