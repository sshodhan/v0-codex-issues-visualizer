import { NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"

const paramsSchema = z.object({ id: z.string().uuid() })

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params
  const parsed = paramsSchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid observation id" }, { status: 400 })
  }

  const observationId = parsed.data.id
  const supabase = await createClient()

  const { data: observation, error: obsError } = await supabase
    .from("mv_observation_current")
    .select(
      "observation_id, source_id, external_id, title, content, url, author, published_at, captured_at, sentiment, sentiment_score, impact_score, category_id, llm_classified_at, cluster_id, cluster_key, frequency_count, is_canonical",
    )
    .eq("observation_id", observationId)
    .maybeSingle()

  if (obsError) {
    return NextResponse.json({ error: "Observation lookup failed", detail: obsError.message }, { status: 500 })
  }
  if (!observation) {
    return NextResponse.json({ error: "Observation not found" }, { status: 404 })
  }

  const [
    fingerprintRes,
    embeddingRes,
    clusterMemberRes,
    classificationsRes,
    categoryAssignmentsRes,
  ] = await Promise.all([
    supabase
      .from("bug_fingerprints")
      .select(
        "id, observation_id, algorithm_version, error_code, top_stack_frame, top_stack_frame_hash, cli_version, os, shell, editor, model_id, repro_markers, keyword_presence, cluster_key_compound, computed_at",
      )
      .eq("observation_id", observationId)
      .order("computed_at", { ascending: false }),
    supabase
      .from("observation_embeddings")
      .select("id, observation_id, algorithm_version, model, dimensions, input_text, computed_at")
      .eq("observation_id", observationId)
      .order("computed_at", { ascending: false }),
    supabase
      .from("cluster_members")
      .select("id, cluster_id, observation_id, attached_at, detached_at")
      .eq("observation_id", observationId)
      .order("attached_at", { ascending: false }),
    supabase
      .from("classifications")
      .select(
        "id, observation_id, prior_classification_id, category, subcategory, severity, status, reproducibility, impact, confidence, summary, root_cause_hypothesis, suggested_fix, tags, evidence_quotes, needs_human_review, review_reasons, model_used, retried_with_large_model, algorithm_version, created_at",
      )
      .eq("observation_id", observationId)
      .order("created_at", { ascending: false }),
    // Topic / regex_topic classifier (Layer 0). Joins categories.slug AND
    // categories.name so the trace page can show "Bug reports (bug)"
    // instead of the bare category UUID; the PostgREST embed inflates as
    // a single object at runtime even though Supabase typings model it
    // as an array (same cast pattern as app/api/admin/cluster/route.ts).
    supabase
      .from("category_assignments")
      .select(
        "id, observation_id, algorithm_version, category_id, confidence, evidence, computed_at, categories:category_id(slug, name)",
      )
      .eq("observation_id", observationId)
      .order("computed_at", { ascending: false }),
  ])

  const fingerprints = fingerprintRes.data ?? []
  const embeddings = embeddingRes.data ?? []
  const clusterMemberships = clusterMemberRes.data ?? []
  const classifications = classificationsRes.data ?? []
  const categoryAssignments = (categoryAssignmentsRes.data ?? []) as unknown as Array<{
    id: string
    observation_id: string
    algorithm_version: string | null
    category_id: string | null
    confidence: number | null
    evidence: unknown
    computed_at: string | null
    categories: { slug: string; name: string } | null
  }>

  if (
    fingerprintRes.error ||
    embeddingRes.error ||
    clusterMemberRes.error ||
    classificationsRes.error ||
    categoryAssignmentsRes.error
  ) {
    return NextResponse.json(
      {
        error: "Failed to compose trace",
        detail:
          fingerprintRes.error?.message ||
          embeddingRes.error?.message ||
          clusterMemberRes.error?.message ||
          classificationsRes.error?.message ||
          categoryAssignmentsRes.error?.message ||
          "unknown",
      },
      { status: 500 },
    )
  }

  const clusterIds = Array.from(new Set(clusterMemberships.map((m) => m.cluster_id).filter(Boolean)))
  const classificationIds = classifications.map((c) => c.id)

  // Source row is fetched alongside cluster + review details so the trace
  // page can render a human-readable source name/slug instead of just the
  // raw `sources.id` UUID surfaced on `mv_observation_current.source_id`.
  // Family classification (Stage 4 sub-product, cluster-level) is fetched
  // here too — one row per cluster, append-only history. We pull every
  // historical row for the active cluster so the trace can show the
  // current interpretation plus the count of revisions, mirroring how
  // the per-observation `classifications` chain renders.
  const activeClusterId = observation.cluster_id ?? null
  const [clustersRes, reviewsRes, sourceRes, familyRes] = await Promise.all([
    clusterIds.length
      ? supabase
          .from("clusters")
          .select(
            "id, cluster_key, canonical_observation_id, status, created_at, label, label_rationale, label_confidence, label_model, label_algorithm_version, labeling_updated_at",
          )
          .in("id", clusterIds)
      : Promise.resolve({ data: [], error: null }),
    classificationIds.length
      ? supabase
          .from("classification_reviews")
          .select(
            "id, classification_id, status, category, severity, needs_human_review, reviewer_notes, reviewed_by, reviewed_at",
          )
          .in("classification_id", classificationIds)
          .order("reviewed_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    observation.source_id
      ? supabase
          .from("sources")
          .select("id, slug, name")
          .eq("id", observation.source_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    activeClusterId
      ? supabase
          .from("family_classifications")
          .select(
            "id, cluster_id, family_kind, family_title, family_summary, needs_human_review, review_reasons, llm_status, model_used, algorithm_version, created_at",
          )
          .eq("cluster_id", activeClusterId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ])

  if (clustersRes.error || reviewsRes.error || sourceRes.error || familyRes.error) {
    return NextResponse.json(
      {
        error: "Failed to enrich trace",
        detail:
          clustersRes.error?.message ||
          reviewsRes.error?.message ||
          sourceRes.error?.message ||
          familyRes.error?.message ||
          "unknown",
      },
      { status: 500 },
    )
  }

  const sourceRow = (sourceRes.data ?? null) as { id: string; slug: string; name: string } | null
  const clustersById = new Map((clustersRes.data ?? []).map((c) => [c.id, c]))
  const activeCluster = observation.cluster_id ? clustersById.get(observation.cluster_id) ?? null : null
  const familyRows = (familyRes.data ?? []) as Array<{
    id: string
    cluster_id: string
    family_kind: string | null
    family_title: string | null
    family_summary: string | null
    needs_human_review: boolean | null
    review_reasons: unknown
    llm_status: string | null
    model_used: string | null
    algorithm_version: string | null
    created_at: string | null
  }>
  const latestFamily = familyRows[0] ?? null
  const reviewsByClassification = new Map<string, unknown[]>()
  for (const review of reviewsRes.data ?? []) {
    const key = review.classification_id as string
    const existing = reviewsByClassification.get(key)
    if (existing) {
      existing.push(review)
    } else {
      reviewsByClassification.set(key, [review])
    }
  }

  const classificationById = new Map(classifications.map((c) => [c.id as string, c]))
  const latestClassification: (typeof classifications)[number] | null = classifications[0] ?? null
  const lineage: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  let walker: (typeof classifications)[number] | null = latestClassification
  while (walker && !seen.has(walker.id as string)) {
    const id = walker.id as string
    seen.add(id)
    lineage.push({
      ...walker,
      reviews: reviewsByClassification.get(id) ?? [],
    })
    const priorId = walker.prior_classification_id as string | null
    walker = priorId ? classificationById.get(priorId) ?? null : null
  }

  return NextResponse.json({
    observation,
    availability: {
      capture: true,
      fingerprint: fingerprints.length > 0,
      embedding: embeddings.length > 0,
      category: categoryAssignments.length > 0,
      clustering: clusterMemberships.length > 0,
      classification: classifications.length > 0,
      family: familyRows.length > 0,
      review: (reviewsRes.data ?? []).length > 0,
    },
    stages: {
      capture: {
        captured_at: observation.captured_at,
        published_at: observation.published_at,
        source_id: observation.source_id,
        source_slug: sourceRow?.slug ?? null,
        source_name: sourceRow?.name ?? null,
      },
      fingerprint: {
        latest_computed_at: fingerprints[0]?.computed_at ?? null,
        algorithm_version: fingerprints[0]?.algorithm_version ?? null,
        total_versions: fingerprints.length,
        rows: fingerprints,
      },
      embedding: {
        latest_computed_at: embeddings[0]?.computed_at ?? null,
        algorithm_version: embeddings[0]?.algorithm_version ?? null,
        model: embeddings[0]?.model ?? null,
        dimensions: embeddings[0]?.dimensions ?? null,
        total_versions: embeddings.length,
        rows: embeddings,
      },
      // Topic (regex_topic, Layer 0). `winner_slug` is the categories.slug
      // joined from the latest category_assignments row, equivalent to
      // evidence.scoring.winner. `confidence` is confidence_proxy — a
      // deterministic score-margin ratio (margin / (winner + runnerUp)),
      // not a calibrated probability. `evidence` is the full TopicEvidence
      // JSONB (or null on pre-v5 rows); see docs/SCORING.md for the shape.
      category: {
        latest_computed_at: categoryAssignments[0]?.computed_at ?? null,
        algorithm_version: categoryAssignments[0]?.algorithm_version ?? null,
        winner_slug: categoryAssignments[0]?.categories?.slug ?? null,
        winner_name: categoryAssignments[0]?.categories?.name ?? null,
        confidence: categoryAssignments[0]?.confidence ?? null,
        evidence: categoryAssignments[0]?.evidence ?? null,
        total_versions: categoryAssignments.length,
        rows: categoryAssignments,
      },
      clustering: {
        active_cluster_id: observation.cluster_id,
        active_cluster_key: observation.cluster_key,
        active_cluster_size: observation.frequency_count,
        active_cluster_label: activeCluster?.label ?? null,
        active_cluster_status: activeCluster?.status ?? null,
        memberships: clusterMemberships.map((membership) => ({
          ...membership,
          cluster: clustersById.get(membership.cluster_id) ?? null,
        })),
      },
      classification: {
        latest_created_at: classifications[0]?.created_at ?? null,
        latest_algorithm_version: classifications[0]?.algorithm_version ?? null,
        latest_model_used: classifications[0]?.model_used ?? null,
        total_versions: classifications.length,
        chain_head_id: latestClassification?.id ?? null,
        lineage,
      },
      // Family classification (Stage 4 sub-product, cluster-level —
      // distinct from per-observation classification above). Heuristic-
      // authoritative on family_kind; LLM enriches title/summary but
      // cannot override (lib/storage/family-classification.ts:165). One
      // append-only row per cluster per algorithm bump; we surface the
      // most recent and the count of revisions.
      family: {
        cluster_id: activeClusterId,
        latest_created_at: latestFamily?.created_at ?? null,
        latest_algorithm_version: latestFamily?.algorithm_version ?? null,
        latest_model_used: latestFamily?.model_used ?? null,
        latest_llm_status: latestFamily?.llm_status ?? null,
        family_kind: latestFamily?.family_kind ?? null,
        family_title: latestFamily?.family_title ?? null,
        family_summary: latestFamily?.family_summary ?? null,
        needs_human_review: latestFamily?.needs_human_review ?? null,
        review_reasons: latestFamily?.review_reasons ?? null,
        total_versions: familyRows.length,
      },
      review: {
        total_reviews: (reviewsRes.data ?? []).length,
        latest_reviewed_at: (reviewsRes.data ?? [])[0]?.reviewed_at ?? null,
        by_classification: Object.fromEntries(reviewsByClassification.entries()),
      },
    },
    generated_at: new Date().toISOString(),
  })
}
