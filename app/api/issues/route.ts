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

// Backward-compatible aliases for sort fields that were renamed during the
// three-layer split. Clients passing the old name continue to work instead
// of silently falling back to impact_score.
const SORT_ALIASES: Record<string, string> = {
  scraped_at: "captured_at",
}

// Reads the materialized view mv_observation_current, which carries one row
// per active cluster canonical observation joined to the latest derivation
// rows. See docs/ARCHITECTURE.md v10 §§3.1c, 5.3.
//
// When ?as_of=<ISO8601> is supplied, reads are routed through the
// observation_current_as_of(ts) RPC instead of the materialized view.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  // Parse as_of parameter for point-in-time replay
  const asOfRaw = searchParams.get("as_of")
  let asOf: Date | null = null
  if (asOfRaw) {
    const parsed = new Date(asOfRaw)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        {
          error: "Invalid as_of",
          message: "as_of must be a valid ISO8601 timestamp",
        },
        { status: 400 },
      )
    }
    if (parsed.getTime() > Date.now() + 60_000) {
      return NextResponse.json(
        {
          error: "Invalid as_of",
          message: "as_of cannot be in the future",
        },
        { status: 400 },
      )
    }
    asOf = parsed
  }

  const source = searchParams.get("source")
  const category = searchParams.get("category")
  const sentiment = searchParams.get("sentiment")
  const days = searchParams.get("days")
  const search = searchParams.get("q")
  const sortByRaw = searchParams.get("sortBy") || "impact_score"
  const sortByAliased = SORT_ALIASES[sortByRaw] ?? sortByRaw
  const sortBy = ALLOWED_SORT.has(sortByAliased) ? sortByAliased : "impact_score"
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

  // When asOf is set, read from the time-bounded RPC; otherwise use the MV
  let data: any[] | null = null
  let error: any = null
  let count: number | null = null

  if (asOf) {
    // Use the point-in-time RPC for historical replay
    const { data: rpcData, error: rpcError } = await supabase.rpc("observation_current_as_of", {
      ts: asOf.toISOString(),
    })
    if (rpcError) {
      return NextResponse.json({ error: rpcError.message }, { status: 500 })
    }

    // Filter and sort in-memory for RPC results
    let rows = ((rpcData || []) as any[]).filter((r: any) => r.is_canonical === true)

    // Apply filters
    if (sourceIds) rows = rows.filter((r: any) => sourceIds!.includes(r.source_id))
    if (categoryIds) rows = rows.filter((r: any) => categoryIds!.includes(r.category_id))
    if (sentiment) rows = rows.filter((r: any) => r.sentiment === sentiment)
    if (days) {
      const parsedDays = parseInt(days)
      if (Number.isFinite(parsedDays) && parsedDays > 0) {
        const daysAgo = new Date(asOf.getTime() - parsedDays * 24 * 60 * 60 * 1000)
        rows = rows.filter((r: any) => r.published_at && new Date(r.published_at) >= daysAgo)
      }
    }
    if (search) {
      const searchLower = search.toLowerCase()
      rows = rows.filter((r: any) =>
        (r.title && r.title.toLowerCase().includes(searchLower)) ||
        (r.content && r.content.toLowerCase().includes(searchLower))
      )
    }

    // Sort
    rows.sort((a: any, b: any) => {
      const aVal = a[sortBy] ?? 0
      const bVal = b[sortBy] ?? 0
      if (order === "asc") return aVal > bVal ? 1 : aVal < bVal ? -1 : 0
      return bVal > aVal ? 1 : bVal < aVal ? -1 : 0
    })

    count = rows.length
    data = rows.slice(offset, offset + limit)
  } else {
    // Use the materialized view for current state
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

    const result = await query
    data = result.data
    error = result.error
    count = result.count
  }

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

  return NextResponse.json({
    data: enriched,
    count,
    asOf: asOf ? asOf.toISOString() : null,
  })
}
