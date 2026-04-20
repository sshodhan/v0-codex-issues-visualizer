import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const MAX_LIMIT = 250
const ALLOWED_SORT = new Set([
  "impact_score",
  "upvotes",
  "comments_count",
  "published_at",
  "scraped_at",
  "sentiment_score",
])

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  const source = searchParams.get("source")
  const category = searchParams.get("category")
  const sentiment = searchParams.get("sentiment")
  const days = searchParams.get("days")
  const search = searchParams.get("q")
  const sortByRaw = searchParams.get("sortBy") || "impact_score"
  const sortBy = ALLOWED_SORT.has(sortByRaw) ? sortByRaw : "impact_score"
  const order = searchParams.get("order") === "asc" ? "asc" : "desc"
  const limit = Math.min(parseInt(searchParams.get("limit") || "100"), MAX_LIMIT)
  const offset = Math.max(parseInt(searchParams.get("offset") || "0"), 0)

  // Resolve source/category slugs to ids first. Filtering on a joined
  // relation with `.eq("source.slug", value)` does NOT actually filter
  // parent rows in supabase-js; this two-step lookup is required.
  let sourceIds: string[] | null = null
  if (source) {
    const { data: srcRows } = await supabase
      .from("sources")
      .select("id")
      .eq("slug", source)
    sourceIds = (srcRows || []).map((r: { id: string }) => r.id)
    if (sourceIds.length === 0) {
      return NextResponse.json({ data: [], count: 0 })
    }
  }

  let categoryIds: string[] | null = null
  if (category) {
    const { data: catRows } = await supabase
      .from("categories")
      .select("id")
      .eq("slug", category)
    categoryIds = (catRows || []).map((r: { id: string }) => r.id)
    if (categoryIds.length === 0) {
      return NextResponse.json({ data: [], count: 0 })
    }
  }

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

  if (sourceIds) query = query.in("source_id", sourceIds)
  if (categoryIds) query = query.in("category_id", categoryIds)
  if (sentiment) query = query.eq("sentiment", sentiment)

  if (days) {
    const parsedDays = parseInt(days)
    if (Number.isFinite(parsedDays) && parsedDays > 0) {
      const daysAgo = new Date()
      daysAgo.setDate(daysAgo.getDate() - parsedDays)
      query = query.gte("published_at", daysAgo.toISOString())
    }
  }

  if (search) {
    // Match on title or content. Both columns are text so ilike is safe.
    const escaped = search.replace(/[%_]/g, (m) => `\\${m}`)
    query = query.or(`title.ilike.%${escaped}%,content.ilike.%${escaped}%`)
  }

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, count })
}
