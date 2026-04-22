import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  analyzeSentiment,
  calculateImpactScore,
  categorizeIssue,
  detectCompetitorMentions,
} from "@/lib/scrapers/shared"
import {
  recordSentiment,
  recordCategory,
  recordImpact,
  recordCompetitorMention,
} from "@/lib/storage/derivations"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"

// Chunked, resumable backfill that walks every observation and writes v2
// derivation rows alongside existing v1 rows.
//
// Why chunked: Vercel serverless caps at maxDuration seconds, but a full
// backfill over ~10k+ observations takes several minutes. The UI calls this
// endpoint in a loop, passing `cursor` (last observation.id seen). The RPCs
// are all `on conflict (observation_id, algorithm_version) do nothing`, so
// rerunning the same batch is a safe no-op.
//
// Append-only by construction — v1 rows stay for replay per ARCHITECTURE §7.4.

export const maxDuration = 60

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000

// Minimal auth: if ADMIN_SECRET is set, require it; if not set, allow through
// (matches /api/scrape's open posture in dev). Never logs the secret.
function authorize(request: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_SECRET
  if (!expected) return null
  const provided = request.headers.get("x-admin-secret")
  if (provided === expected) return null
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface BackfillBody {
  cursor?: string | null
  limit?: number
  dryRun?: boolean
}

export async function POST(request: NextRequest) {
  const unauthorized = authorize(request)
  if (unauthorized) return unauthorized

  const body: BackfillBody = await request.json().catch(() => ({}))
  const cursor = body.cursor ?? null
  const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
  const dryRun = body.dryRun === true

  const supabase = createAdminClient()

  // Load categories once — categorizeIssue needs the full list to map a slug
  // back to the stored id.
  const { data: categories, error: catErr } = await supabase
    .from("categories")
    .select("*")
  if (catErr || !categories) {
    return NextResponse.json(
      { error: "Failed to load categories", details: catErr?.message },
      { status: 500 },
    )
  }

  // Load sources once so we can map observation.source_id → source.slug for
  // the impact authority multiplier.
  const { data: sources, error: srcErr } = await supabase
    .from("sources")
    .select("id, slug")
  if (srcErr || !sources) {
    return NextResponse.json(
      { error: "Failed to load sources", details: srcErr?.message },
      { status: 500 },
    )
  }
  const slugById = new Map<string, string>(sources.map((s) => [s.id, s.slug]))

  // Keyset pagination by observation.id. Stable scan even if new
  // observations are inserted mid-run: new rows either sort after our
  // cursor (picked up in a later chunk) or before (skipped here — fine,
  // since the ingest path already stamps them v2 on write).
  let q = supabase
    .from("observations")
    .select("id, source_id, title, content")
    .order("id", { ascending: true })
    .limit(limit)
  if (cursor) q = q.gt("id", cursor)

  const { data: observations, error: obsErr } = await q
  if (obsErr) {
    return NextResponse.json(
      { error: "Failed to load observations", details: obsErr.message },
      { status: 500 },
    )
  }
  if (!observations || observations.length === 0) {
    return NextResponse.json({
      processed: 0,
      writes: { sentiment: 0, category: 0, impact: 0, competitor_mention: 0 },
      nextCursor: null,
      done: true,
      dryRun,
      versions: CURRENT_VERSIONS,
    })
  }

  // Load latest engagement per observation in this chunk. One query, keyed
  // by observation_id, taking the newest captured_at.
  const obsIds = observations.map((o) => o.id)
  const { data: engagement } = await supabase
    .from("engagement_snapshots")
    .select("observation_id, upvotes, comments_count, captured_at")
    .in("observation_id", obsIds)
    .order("captured_at", { ascending: false })

  const engagementByObs = new Map<string, { upvotes: number; comments_count: number }>()
  for (const row of engagement ?? []) {
    if (!engagementByObs.has(row.observation_id)) {
      engagementByObs.set(row.observation_id, {
        upvotes: row.upvotes ?? 0,
        comments_count: row.comments_count ?? 0,
      })
    }
  }

  const writes = { sentiment: 0, category: 0, impact: 0, competitor_mention: 0 }
  const sampleDiffs: Array<{
    id: string
    title: string
    sentiment: string
    category_slug: string | undefined
    impact: number
    competitors: string[]
  }> = []

  for (const obs of observations) {
    const text = `${obs.title ?? ""} ${obs.content ?? ""}`.trim()
    const engagement = engagementByObs.get(obs.id) ?? { upvotes: 0, comments_count: 0 }
    const sourceSlug = slugById.get(obs.source_id)

    const { sentiment, score: sentimentScore, keyword_presence } = analyzeSentiment(text)
    const categoryId = categorizeIssue(text, categories)
    const categorySlug = categories.find((c) => c.id === categoryId)?.slug
    const impact = calculateImpactScore(
      engagement.upvotes,
      engagement.comments_count,
      sentiment,
      sourceSlug,
    )
    const competitors = detectCompetitorMentions(text)

    if (sampleDiffs.length < 10) {
      sampleDiffs.push({
        id: obs.id,
        title: (obs.title ?? "").slice(0, 120),
        sentiment,
        category_slug: categorySlug,
        impact,
        competitors,
      })
    }

    if (dryRun) continue

    await recordSentiment(supabase, obs.id, {
      label: sentiment,
      score: sentimentScore,
      keyword_presence,
    })
    writes.sentiment++

    if (categoryId) {
      await recordCategory(supabase, obs.id, categoryId, 1.0)
      writes.category++
    }

    await recordImpact(supabase, obs.id, impact, {
      upvotes: engagement.upvotes,
      comments_count: engagement.comments_count,
      sentiment_label: sentiment,
      source_slug: sourceSlug ?? null,
    })
    writes.impact++

    // Competitor mentions: one row per detected competitor. We pass null for
    // sentence_window/sentiment_score/confidence — the backfill uses the
    // canonical lexicon (v2) but doesn't reconstruct per-mention windows
    // from the stored text. This matches ingest-path behavior.
    for (const competitor of competitors) {
      await recordCompetitorMention(supabase, obs.id, {
        competitor,
        sentence_window: null,
        sentiment_score: null,
        confidence: null,
      })
      writes.competitor_mention++
    }
  }

  const nextCursor = observations[observations.length - 1].id
  const done = observations.length < limit

  return NextResponse.json({
    processed: observations.length,
    writes,
    nextCursor: done ? null : nextCursor,
    done,
    dryRun,
    versions: CURRENT_VERSIONS,
    sampleDiffs,
  })
}

// GET returns the count of observations so the UI can show progress as a
// fraction.
export async function GET(request: NextRequest) {
  const unauthorized = authorize(request)
  if (unauthorized) return unauthorized

  const supabase = createAdminClient()
  const { count: totalObservations } = await supabase
    .from("observations")
    .select("*", { count: "exact", head: true })

  return NextResponse.json({
    totalObservations: totalObservations ?? 0,
    versions: CURRENT_VERSIONS,
  })
}
