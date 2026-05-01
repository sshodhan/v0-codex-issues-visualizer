import { NextRequest, NextResponse } from "next/server"
import { requireAdminSecret } from "@/lib/admin/auth"
import { createAdminClient } from "@/lib/supabase/admin"
import { logServerError } from "@/lib/error-tracking/server-logger"
import {
  buildCoveragePreview,
  summarizeEmbeddingSignalCoverage,
  type EmbeddingSignalCoverageRow,
} from "@/lib/embeddings/signal-coverage"

const DEFAULT_LIMIT = 5000
const MAX_LIMIT = 20000
const DEFAULT_DAYS = 30
const MAX_DAYS = 365

/** Status values from `classification_reviews.status` that count as
 *  "review-flagged" — i.e., reviewer explicitly does not endorse the
 *  LLM output and v3 should NOT use its taxonomy.
 *
 *  `classification_reviews.status` is `text` (no enum constraint), so
 *  the set of values that can land in this column is determined by
 *  the reviewer UI rather than the schema. The list below covers the
 *  documented review-decision states across reviewer flows:
 *    - `flagged` / `needs_review` — reviewer escalated for follow-up
 *    - `rejected` / `incorrect` / `invalid` — reviewer disagreed with
 *      the LLM's assignment
 *    - `unclear` — reviewer couldn't decide; treat as untrusted
 *  Approved/correct values are intentionally absent — those should
 *  let the LLM taxonomy through unchanged.
 *
 *  Operators verifying the live distribution can run:
 *    SELECT status, COUNT(*) FROM classification_reviews GROUP BY 1;
 *  If a reviewer state appears that should also gate the LLM output,
 *  add it here in one place — every consumer (this route + the
 *  signal-coverage metric + the Phase 4 caller) uses the same set. */
const FLAGGED_REVIEW_STATUSES = new Set([
  "flagged",
  "needs_review",
  "rejected",
  "incorrect",
  "invalid",
  "unclear",
])

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const params = request.nextUrl.searchParams
  const limitRaw = Number.parseInt(params.get("limit") ?? `${DEFAULT_LIMIT}`, 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, MAX_LIMIT)) : DEFAULT_LIMIT

  // Default to a 30-day window so the metric reflects current pipeline
  // state, not all-time average. ?days=0 explicitly opts out (use the
  // full corpus). Capped at MAX_DAYS to prevent runaway scans.
  const daysRaw = Number.parseInt(params.get("days") ?? `${DEFAULT_DAYS}`, 10)
  const days = Number.isFinite(daysRaw) ? Math.max(0, Math.min(daysRaw, MAX_DAYS)) : DEFAULT_DAYS

  const includePreview = params.get("include_preview") === "true"
  const previewLimitRaw = Number.parseInt(params.get("preview_limit") ?? "50", 10)
  const previewLimit = Number.isFinite(previewLimitRaw) ? Math.max(1, Math.min(previewLimitRaw, 500)) : 50

  const supabase = createAdminClient()

  // ---- Step 1: pull observation rows + per-row signals from the MV ----
  // Note: `mv_observation_current` does NOT carry `category_slug` or
  // `llm_review_status`. We fetch `category_id` here and resolve to
  // slug via a follow-up `categories` lookup; review state is fetched
  // from `classification_reviews` in step 2.
  // We also pull llm_severity here — the MV exposes it directly. The
  // remaining helper-input fields that live on `classifications` but
  // NOT on the MV (`reproducibility`, `impact`, full `tags` array) are
  // fetched in step 2 via a `classifications` lookup, so the Phase 2
  // metric and Phase 4 production pipeline see the same row shape and
  // the v3 helper can emit the full Tier 2 signal set.
  let q = supabase
    .from("mv_observation_current")
    .select(
      "observation_id, title, content, category_id, error_code, top_stack_frame, cli_version, fp_os, fp_shell, fp_editor, model_id, repro_markers, llm_category, llm_subcategory, llm_primary_tag, llm_confidence, llm_severity",
    )
    .eq("is_canonical", true)
    .order("captured_at", { ascending: false })
    .limit(limit)

  if (days > 0) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    q = q.gte("captured_at", since)
  }

  const { data: mvRows, error: mvErr } = await q
  if (mvErr) {
    return NextResponse.json({ error: mvErr.message }, { status: 500 })
  }

  const observationIds = (mvRows ?? []).map((r) => r.observation_id as string)
  const categoryIds = Array.from(
    new Set((mvRows ?? []).map((r) => r.category_id as string | null).filter(Boolean) as string[]),
  )

  // ---- Step 2: side-tables for category_slug, classifications side fields, reviewer overrides ----
  // All three lookups are best-effort. If any fails we log and continue
  // with the partial dataset — the summary numbers will be slightly
  // lower than reality but the endpoint still returns a usable response.
  // The `classifications` query fetches reproducibility / impact / tags
  // (Tier 2 helper inputs that the MV doesn't expose) plus a duplicate
  // of subcategory we use as a freshness check; we take the latest row
  // per observation_id.
  const [catRes, clsRes, reviewRes] = await Promise.all([
    categoryIds.length > 0
      ? supabase.from("categories").select("id, slug").in("id", categoryIds)
      : Promise.resolve({ data: [] as Array<{ id: string; slug: string }>, error: null }),
    observationIds.length > 0
      ? supabase
          .from("classifications")
          .select("observation_id, reproducibility, impact, tags, created_at")
          .in("observation_id", observationIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    observationIds.length > 0
      ? supabase
          .from("classification_reviews")
          .select(
            "classification_id, category, subcategory, severity, status, needs_human_review, reviewed_at, classifications!inner(observation_id)",
          )
          .in("classifications.observation_id", observationIds)
          .order("reviewed_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ])

  if (catRes.error) {
    logServerError("admin-embedding-signal-coverage", "categories_lookup_failed", catRes.error)
  }
  if (clsRes.error) {
    logServerError("admin-embedding-signal-coverage", "classifications_lookup_failed", clsRes.error)
  }
  if (reviewRes.error) {
    logServerError("admin-embedding-signal-coverage", "reviews_lookup_failed", reviewRes.error)
  }

  const slugById = new Map<string, string>()
  for (const row of (catRes.data ?? []) as Array<{ id: string; slug: string }>) {
    if (row.id && row.slug) slugById.set(row.id, row.slug)
  }

  // Latest classification row per observation. The query was ordered
  // by `created_at desc` so the first row we see for a given
  // observation_id is the freshest; we take that and ignore older
  // rows. `tags` is `text[]`; PostgREST returns it as a JS array.
  const clsByObsId = new Map<
    string,
    { reproducibility: string | null; impact: string | null; tags: string[] | null }
  >()
  for (const row of (clsRes.data ?? []) as Array<{
    observation_id: string
    reproducibility: string | null
    impact: string | null
    tags: string[] | null
  }>) {
    if (!row.observation_id || clsByObsId.has(row.observation_id)) continue
    clsByObsId.set(row.observation_id, {
      reproducibility: row.reproducibility ?? null,
      impact: row.impact ?? null,
      tags: row.tags ?? null,
    })
  }

  // Most-recent review per observation. PostgREST returns the embedded
  // `classifications` relationship as either an object or array of objects
  // depending on join shape — handle both.
  const reviewByObsId = new Map<
    string,
    {
      category: string | null
      subcategory: string | null
      severity: string | null
      status: string | null
      needs_human_review: boolean
    }
  >()
  for (const row of (reviewRes.data ?? []) as unknown as Array<{
    classifications: { observation_id: string } | { observation_id: string }[] | null
    category: string | null
    subcategory: string | null
    severity: string | null
    status: string | null
    needs_human_review: boolean | null
  }>) {
    const classRel = Array.isArray(row.classifications) ? row.classifications[0] : row.classifications
    const obsId = classRel?.observation_id
    if (!obsId || reviewByObsId.has(obsId)) continue
    reviewByObsId.set(obsId, {
      category: row.category ?? null,
      subcategory: row.subcategory ?? null,
      severity: row.severity ?? null,
      status: row.status ?? null,
      needs_human_review: row.needs_human_review === true,
    })
  }

  // ---- Step 3: build the row shape the summarizer/preview expect ----
  const rows: EmbeddingSignalCoverageRow[] = (mvRows ?? []).map((mv) => {
    const obsId = mv.observation_id as string
    const review = reviewByObsId.get(obsId)
    const cls = clsByObsId.get(obsId)
    const reviewStatusLower = review?.status?.toLowerCase().trim() ?? ""
    const reviewFlagged =
      review?.needs_human_review === true || FLAGGED_REVIEW_STATUSES.has(reviewStatusLower)

    return {
      observation_id: obsId,
      title: (mv.title as string | null) ?? null,
      content: (mv.content as string | null) ?? null,
      category_slug: mv.category_id ? (slugById.get(mv.category_id as string) ?? null) : null,
      error_code: (mv.error_code as string | null) ?? null,
      top_stack_frame: (mv.top_stack_frame as string | null) ?? null,
      cli_version: (mv.cli_version as string | null) ?? null,
      fp_os: (mv.fp_os as string | null) ?? null,
      fp_shell: (mv.fp_shell as string | null) ?? null,
      fp_editor: (mv.fp_editor as string | null) ?? null,
      model_id: (mv.model_id as string | null) ?? null,
      repro_markers: (mv.repro_markers as number | null) ?? null,
      llm_category: (mv.llm_category as string | null) ?? null,
      llm_subcategory: (mv.llm_subcategory as string | null) ?? null,
      llm_primary_tag: (mv.llm_primary_tag as string | null) ?? null,
      llm_severity: (mv.llm_severity as string | null) ?? null,
      // Tier 2 helper inputs from `classifications` (not on the MV).
      llm_reproducibility: cls?.reproducibility ?? null,
      llm_impact: cls?.impact ?? null,
      llm_tags: cls?.tags ?? null,
      // PostgREST may return `numeric` as either string or number;
      // bucketConfidence in the summarizer handles both.
      llm_confidence: (mv.llm_confidence as number | string | null) ?? null,
      review_flagged: reviewFlagged,
      reviewer_category: review?.category ?? null,
      reviewer_subcategory: review?.subcategory ?? null,
    }
  })

  const summary = summarizeEmbeddingSignalCoverage(rows)
  const preview = includePreview ? buildCoveragePreview(rows.slice(0, previewLimit)) : undefined

  return NextResponse.json({
    sampled_rows: rows.length,
    limit,
    days,
    include_preview: includePreview,
    summary,
    preview,
  })
}
