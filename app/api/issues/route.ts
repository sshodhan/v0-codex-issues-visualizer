import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const MAX_LIMIT = 250
const ALLOWED_SORT = new Set([
  "impact_score",
  "upvotes",
  "comments_count",
  "published_at",
  "captured_at",
  "sentiment_score",
])

// Reads the materialized view mv_observation_current, which carries one row
// per active cluster canonical observation joined to the latest derivation
// rows. See docs/ARCHITECTURE.md v10 §§3.1c, 5.3.
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
    .from("mv_observation_current")
    .select("*", { count: "exact" })
    .eq("is_canonical", true)
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
    const escaped = search.replace(/[%_]/g, (m) => `\\${m}`)
    query = query.or(`title.ilike.%${escaped}%,content.ilike.%${escaped}%`)
  }

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Shape-compat: consumers expect `id`, `source`, `category` fields.
  // Attach sources/categories lookups in JS (cheap, cached by Postgres planner).
  const rows = data || []
  const neededSourceIds = new Set(rows.map((r: any) => r.source_id).filter(Boolean))
  const neededCategoryIds = new Set(rows.map((r: any) => r.category_id).filter(Boolean))

  const [sourcesMap, categoriesMap] = await Promise.all([
    neededSourceIds.size
      ? supabase
          .from("sources")
          .select("*")
          .in("id", [...neededSourceIds])
          .then(({ data }: { data: any[] | null }) =>
            new Map<string, any>((data || []).map((s: any) => [s.id, s])),
          )
      : Promise.resolve(new Map<string, any>()),
    neededCategoryIds.size
      ? supabase
          .from("categories")
          .select("*")
          .in("id", [...neededCategoryIds])
          .then(({ data }: { data: any[] | null }) =>
            new Map<string, any>((data || []).map((c: any) => [c.id, c])),
          )
      : Promise.resolve(new Map<string, any>()),
  ])

  const enriched = rows.map((r: any) => ({
    ...r,
    id: r.observation_id,
    source: r.source_id ? sourcesMap.get(r.source_id) ?? null : null,
    category: r.category_id ? categoriesMap.get(r.category_id) ?? null : null,
  }))

  return NextResponse.json({ data: enriched, count })
}
