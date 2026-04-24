import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clusterId: string }> },
) {
  const { clusterId } = await params
  if (!UUID_RE.test(clusterId)) {
    return NextResponse.json(
      { error: "Invalid clusterId", message: "clusterId must be a UUID" },
      { status: 400 },
    )
  }

  const supabase = await createClient()
  const daysRaw = request.nextUrl.searchParams.get("days")
  const parsedDays = daysRaw ? Number.parseInt(daysRaw, 10) : NaN
  const windowDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : null
  const cutoffIso = windowDays
    ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
    : null

  let q = supabase
    .from("mv_observation_current")
    .select(
      "observation_id, title, url, source_name, sentiment, impact_score, frequency_count, llm_classified_at, published_at, cluster_key_compound, error_code",
    )
    .eq("is_canonical", true)
    .eq("cluster_id", clusterId)
    .order("impact_score", { ascending: false })
    .limit(500)

  if (cutoffIso) q = q.gte("published_at", cutoffIso)

  const { data: rows, error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({ family: null, variants: [], trend: [] })
  }

  const { data: clusterMeta } = await supabase
    .from("clusters")
    .select("id, label, label_confidence")
    .eq("id", clusterId)
    .maybeSingle()

  const { data: clusterHealth } = await supabase
    .from("mv_cluster_health_current")
    .select(
      "cluster_id, cluster_path, cluster_size, classified_count, reviewed_count, fingerprint_hit_rate, dominant_error_code_share, dominant_stack_frame_share, intra_cluster_similarity_proxy, nearest_cluster_gap_proxy",
    )
    .eq("cluster_id", clusterId)
    .maybeSingle()

  const total = rows.length
  const classifiedCount = rows.filter((r: any) => Boolean(r.llm_classified_at)).length
  const sourceCounts = new Map<string, number>()
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 }
  const trendCounts = new Map<string, number>()

  for (const row of rows as any[]) {
    const source = row.source_name || "unknown"
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1)
    const s = row.sentiment as "positive" | "neutral" | "negative" | null
    if (s && s in sentimentCounts) sentimentCounts[s] += 1
    if (row.published_at) {
      const day = new Date(row.published_at).toISOString().slice(0, 10)
      trendCounts.set(day, (trendCounts.get(day) || 0) + 1)
    }
  }

  const sourceCoverage = Array.from(sourceCounts.entries())
    .map(([source, count]) => ({ source, count, share: count / total }))
    .sort((a, b) => b.count - a.count)

  const trend = Array.from(trendCounts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const representativeObservations = (rows as any[])
    .slice(0, 8)
    .map((row) => ({
      observation_id: row.observation_id,
      title: row.title,
      url: row.url,
      source_name: row.source_name,
      impact_score: row.impact_score,
      error_code: row.error_code,
      cluster_key_compound: row.cluster_key_compound,
    }))

  const { data: members, error: membersError } = await supabase
    .from("cluster_members")
    .select("observation_id")
    .eq("cluster_id", clusterId)
    .is("detached_at", null)

  if (membersError) {
    return NextResponse.json({ error: membersError.message }, { status: 500 })
  }

  const observationIds = (members || []).map((m: { observation_id: string }) => m.observation_id)
  let variants: Array<{
    key: string
    error_code: string | null
    top_stack_frame_hash: string | null
    top_stack_frame: string | null
    count: number
    examples: string[]
  }> = []

  if (observationIds.length > 0) {
    const { data: fingerprints, error: fpError } = await supabase
      .from("bug_fingerprints")
      .select("observation_id, error_code, top_stack_frame_hash, top_stack_frame, cluster_key_compound, computed_at")
      .in("observation_id", observationIds)
      .order("computed_at", { ascending: false })

    if (fpError) {
      return NextResponse.json({ error: fpError.message }, { status: 500 })
    }

    const latestByObservation = new Map<string, any>()
    for (const fp of fingerprints || []) {
      const observationId = (fp as any).observation_id as string
      if (!latestByObservation.has(observationId)) latestByObservation.set(observationId, fp)
    }

    const variantAgg = new Map<string, { count: number; exemplarTitles: string[]; fp: any }>()
    const titleMap = new Map((rows as any[]).map((r) => [r.observation_id as string, r.title as string]))
    for (const fp of latestByObservation.values()) {
      const key =
        (fp.cluster_key_compound as string | null) ||
        `err:${fp.error_code ?? "unknown"}|frame:${fp.top_stack_frame_hash ?? "none"}`
      const cur = variantAgg.get(key) || { count: 0, exemplarTitles: [], fp }
      cur.count += 1
      const title = titleMap.get(fp.observation_id as string)
      if (title && cur.exemplarTitles.length < 3) cur.exemplarTitles.push(title)
      variantAgg.set(key, cur)
    }

    variants = Array.from(variantAgg.entries())
      .map(([key, v]) => ({
        key,
        error_code: v.fp.error_code ?? null,
        top_stack_frame_hash: v.fp.top_stack_frame_hash ?? null,
        top_stack_frame: v.fp.top_stack_frame ?? null,
        count: v.count,
        examples: v.exemplarTitles,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)
  }

  return NextResponse.json({
    family: {
      id: clusterId,
      label: clusterMeta?.label ?? null,
      label_confidence: clusterMeta?.label_confidence ?? null,
      fallback_title: (rows[0] as any).title ?? null,
      total_observations: total,
      classified_count: classifiedCount,
      triage_coverage_ratio: total > 0 ? classifiedCount / total : 0,
      sentiment: sentimentCounts,
      source_coverage: sourceCoverage,
      representative_observations: representativeObservations,
      window_days: windowDays,
      reviewed_count: (clusterHealth as any)?.reviewed_count ?? 0,
      cluster_path:
        ((clusterHealth as any)?.cluster_path ?? "fallback") as "semantic" | "fallback",
      fingerprint_hit_rate: Number((clusterHealth as any)?.fingerprint_hit_rate ?? 0),
      dominant_error_code_share: Number(
        (clusterHealth as any)?.dominant_error_code_share ?? 0,
      ),
      dominant_stack_frame_share: Number(
        (clusterHealth as any)?.dominant_stack_frame_share ?? 0,
      ),
      intra_cluster_similarity_proxy: Number(
        (clusterHealth as any)?.intra_cluster_similarity_proxy ?? 0,
      ),
      nearest_cluster_gap_proxy: Number(
        (clusterHealth as any)?.nearest_cluster_gap_proxy ?? 0,
      ),
    },
    trend,
    variants,
  })
}
