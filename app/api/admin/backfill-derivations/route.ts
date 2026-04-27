import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { logServer, logServerError } from "@/lib/error-tracking/server-logger"
import {
  analyzeSentiment,
  calculateImpactScore,
  categorizeIssue,
  detectCompetitorMentions,
} from "@/lib/scrapers/shared"
import {
  recordCategory,
  recordCompetitorMention,
  recordImpact,
  recordSentiment,
} from "@/lib/storage/derivations"
import { CURRENT_VERSIONS } from "@/lib/storage/algorithm-versions"
import type { Category } from "@/lib/types"

export const maxDuration = 300

// Rewrites every observation's derivation rows at the currently-effective
// algorithm version. Chunked (Vercel Pro 300s cap) and resumable via cursor.
// Idempotent: sentiment/category/impact have unique(observation_id,
// algorithm_version); competitor_mention has no such constraint so we
// pre-check before writing.
//
// See docs/ARCHITECTURE.md v10 §§3.1b, 5.2, 7.4.

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000
const SAMPLE_SIZE = 10

type Kind = "sentiment" | "category" | "impact" | "competitor_mention"

interface SampleDiff {
  observation_id: string
  title: string
  computed: {
    sentiment: { label: string; score: number; keyword_presence: number }
    category_slug: string | null
    impact: number
    competitors: string[]
  }
}

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const supabase = createAdminClient()
  const { count, error } = await supabase
    .from("observations")
    .select("*", { count: "exact", head: true })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    totalObservations: count ?? 0,
    versions: CURRENT_VERSIONS,
  })
}

export async function POST(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  let body: { cursor?: string | null; limit?: number; dryRun?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    // Empty body is fine — defaults apply.
  }

  const cursor = body.cursor ?? null
  const limit = Math.max(1, Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const dryRun = body.dryRun === true

  // Log the start of an apply run (first chunk only) — critical action
  // that modifies the derivation layer at scale.
  if (!dryRun && !cursor) {
    logServer({
      component: "admin-backfill",
      event: "apply_started",
      level: "info",
      data: { limit, versions: CURRENT_VERSIONS },
    })
  }

  const supabase = createAdminClient()

  // 1. One-shot per request: load categories + sources slug map.
  const [categoriesRes, sourcesRes] = await Promise.all([
    supabase.from("categories").select("id, name, slug, color, created_at"),
    supabase.from("sources").select("id, slug"),
  ])
  if (categoriesRes.error) {
    return NextResponse.json({ error: categoriesRes.error.message }, { status: 500 })
  }
  if (sourcesRes.error) {
    return NextResponse.json({ error: sourcesRes.error.message }, { status: 500 })
  }
  const categories = (categoriesRes.data ?? []) as Category[]
  const categorySlugById = new Map(categories.map((c) => [c.id, c.slug]))
  const slugById = new Map(
    (sourcesRes.data ?? []).map((s) => [s.id as string, s.slug as string]),
  )

  // 2. Keyset page of observations.
  let obsQuery = supabase
    .from("observations")
    .select("id, source_id, title, content")
    .order("id", { ascending: true })
    .limit(limit)
  if (cursor) obsQuery = obsQuery.gt("id", cursor)
  const obsRes = await obsQuery
  if (obsRes.error) {
    return NextResponse.json({ error: obsRes.error.message }, { status: 500 })
  }
  const observations = obsRes.data ?? []

  if (observations.length === 0) {
    return NextResponse.json({
      processed: 0,
      writes: { sentiment: 0, category: 0, impact: 0, competitor_mention: 0 },
      nextCursor: null,
      done: true,
      dryRun,
      versions: CURRENT_VERSIONS,
      ...(dryRun ? { sampleDiffs: [] as SampleDiff[] } : {}),
    })
  }

  const chunkIds = observations.map((o) => o.id as string)
  const lastId = chunkIds[chunkIds.length - 1]

  // 3. Latest engagement per observation in this chunk.
  // PostgREST defaults cap at 1000 rows. With N observations * M snapshots
  // this truncates silently and later observations fall back to zeroed
  // inputs, corrupting the v2 impact score. Explicit range raises the cap.
  const engagementRes = await supabase
    .from("engagement_snapshots")
    .select("observation_id, upvotes, comments_count, captured_at")
    .in("observation_id", chunkIds)
    .order("captured_at", { ascending: false })
    .range(0, 99_999)
  if (engagementRes.error) {
    return NextResponse.json({ error: engagementRes.error.message }, { status: 500 })
  }
  const latestEngagement = new Map<
    string,
    { upvotes: number; comments_count: number }
  >()
  for (const row of engagementRes.data ?? []) {
    const oid = row.observation_id as string
    if (latestEngagement.has(oid)) continue
    latestEngagement.set(oid, {
      upvotes: (row.upvotes as number) ?? 0,
      comments_count: (row.comments_count as number) ?? 0,
    })
  }

  // 4. Pre-check which observations already have v2 rows per kind.
  const alreadyV2 = await loadAlreadyV2(supabase, chunkIds)

  // 5. Compute, optionally write.
  const writes = { sentiment: 0, category: 0, impact: 0, competitor_mention: 0 }
  const sampleDiffs: SampleDiff[] = []

  // Per-kind promise fan-out keeps wall-clock well below maxDuration.
  const tasks: Promise<void>[] = []

  for (const obs of observations) {
    const id = obs.id as string
    const title = (obs.title as string) ?? ""
    const content = (obs.content as string | null) ?? ""
    const sourceSlug = slugById.get(obs.source_id as string) ?? null
    const text = `${title} ${content}`.trim()

    const sentimentResult = analyzeSentiment(text)
    const categoryId = categorizeIssue(text, categories) ?? null
    const engagement = latestEngagement.get(id) ?? { upvotes: 0, comments_count: 0 }
    const impact = calculateImpactScore(
      engagement.upvotes,
      engagement.comments_count,
      sentimentResult.sentiment,
      sourceSlug ?? undefined,
    )
    const competitors = detectCompetitorMentions(text)

    if (sampleDiffs.length < SAMPLE_SIZE) {
      sampleDiffs.push({
        observation_id: id,
        title,
        computed: {
          sentiment: {
            label: sentimentResult.sentiment,
            score: sentimentResult.score,
            keyword_presence: sentimentResult.keyword_presence,
          },
          category_slug: categoryId ? categorySlugById.get(categoryId) ?? null : null,
          impact,
          competitors,
        },
      })
    }

    if (!alreadyV2.sentiment.has(id)) {
      writes.sentiment++
      if (!dryRun) {
        tasks.push(
          recordSentiment(supabase, id, {
            label: sentimentResult.sentiment,
            score: sentimentResult.score,
            keyword_presence: sentimentResult.keyword_presence,
          }),
        )
      }
    }

    if (categoryId && !alreadyV2.category.has(id)) {
      writes.category++
      if (!dryRun) {
        tasks.push(recordCategory(supabase, id, categoryId, 1.0))
      }
    }

    if (!alreadyV2.impact.has(id)) {
      writes.impact++
      if (!dryRun) {
        tasks.push(
          recordImpact(supabase, id, impact, {
            upvotes: engagement.upvotes,
            comments_count: engagement.comments_count,
            sentiment_label: sentimentResult.sentiment,
            source_slug: sourceSlug,
          }),
        )
      }
    }

    // Per-(observation, competitor) dedup: the mention table has no
    // unique constraint at this granularity, so we can't rely on
    // ON CONFLICT. Per-observation skip would silently drop competitors
    // added to the lexicon after the initial backfill.
    for (const competitor of competitors) {
      const key = `${id}::${competitor}`
      if (alreadyV2.competitor_mention.has(key)) continue
      writes.competitor_mention++
      if (!dryRun) {
        tasks.push(
          recordCompetitorMention(supabase, id, {
            competitor,
            sentence_window: null,
            sentiment_score: null,
            confidence: null,
          }),
        )
      }
    }
  }

  if (!dryRun && tasks.length > 0) {
    await Promise.all(tasks)
  }

  const processed = observations.length
  const done = processed < limit

  // Refresh MVs on the final chunk of an apply run so the dashboard
  // actually picks up the new v2 rows. Without this, mv_observation_current
  // keeps serving pre-backfill state until the next scrape cron tick.
  let refreshedMvs = false
  if (done && !dryRun) {
    const { error: refreshErr } = await supabase.rpc("refresh_materialized_views")
    if (refreshErr) {
      logServerError("admin-backfill", "mv_refresh_failed", refreshErr)
    } else {
      refreshedMvs = true
    }
    logServer({
      component: "admin-backfill",
      event: "apply_completed",
      level: "info",
      data: { writes, refreshedMvs },
    })
  }

  return NextResponse.json({
    processed,
    writes,
    nextCursor: done ? null : lastId,
    done,
    dryRun,
    versions: CURRENT_VERSIONS,
    refreshedMvs,
    ...(dryRun ? { sampleDiffs } : {}),
  })
}

// For sentiment/category/impact the DB enforces unique(observation_id,
// algorithm_version) so Set<observation_id> is sufficient. For
// competitor_mention there is no such constraint; we track
// `${observation_id}::${competitor}` composite keys so re-runs with a
// newly-added competitor still write the missing row.
async function loadAlreadyV2(
  supabase: ReturnType<typeof createAdminClient>,
  chunkIds: string[],
): Promise<Record<Kind, Set<string>>> {
  const byObservation: Record<
    Exclude<Kind, "competitor_mention">,
    string
  > = {
    sentiment: "sentiment_scores",
    category: "category_assignments",
    impact: "impact_scores",
  }

  const observationChecks = Promise.all(
    (Object.entries(byObservation) as Array<
      [Exclude<Kind, "competitor_mention">, string]
    >).map(async ([kind, table]) => {
      const { data, error } = await supabase
        .from(table)
        .select("observation_id")
        .in("observation_id", chunkIds)
        .eq("algorithm_version", CURRENT_VERSIONS[kind])
        .range(0, 99_999)
      if (error) {
        logServerError("admin-backfill", "precheck_failed", error, { table })
        return [kind, new Set<string>()] as const
      }
      return [
        kind,
        new Set<string>((data ?? []).map((r) => r.observation_id as string)),
      ] as const
    }),
  )

  const mentionCheck = (async () => {
    const { data, error } = await supabase
      .from("competitor_mentions")
      .select("observation_id, competitor")
      .in("observation_id", chunkIds)
      .eq("algorithm_version", CURRENT_VERSIONS.competitor_mention)
      .range(0, 99_999)
    if (error) {
      logServerError("admin-backfill", "precheck_failed", error, {
        table: "competitor_mentions",
      })
      return new Set<string>()
    }
    return new Set<string>(
      (data ?? []).map(
        (r) => `${r.observation_id as string}::${r.competitor as string}`,
      ),
    )
  })()

  const [obsEntries, mentionSet] = await Promise.all([
    observationChecks,
    mentionCheck,
  ])

  return {
    ...Object.fromEntries(obsEntries),
    competitor_mention: mentionSet,
  } as Record<Kind, Set<string>>
}
