import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { logServerError } from "@/lib/error-tracking/server-logger"
import {
  aggregateClusters,
  type ClusterLabelRow,
  type ClusterObservationRow,
} from "@/lib/classification/clusters"

// Direct cluster read for the triage tab's semantic-cluster chip strip,
// independent of the classification pipeline. Previously the chip strip
// read clusters off `ClassificationRecord.cluster_id`, which meant a
// reviewer with 66 clustered observations but 0 classifications saw
// nothing — the cluster surface was invisible until classify-backfill
// had run. See docs/CLUSTERING_DESIGN.md §7.
//
// Response shape:
//   {
//     clusters: Array<{
//       id, cluster_key, label, label_confidence,
//       size,              // total active members across all time (from
//                          // mv_observation_current.frequency_count)
//       in_window: number, // observations matching is_canonical + the
//                          // optional ?days=N window
//       classified_count:  // subset of in_window with llm_classified_at
//                          // populated — tells the UI how many of the
//                          // cluster's visible members would appear in
//                          // the triage queue below
//       samples:           // top 3 highest-impact member titles, used
//                          // for the chip-strip preview drawer when
//                          // there are no classifications to filter
//     }>,
//     windowDays: number | null,
//     source: "observations"
//   }
//
// Aggregation is client-side over a capped SELECT (LIMIT 500) rather
// than a server-side GROUP BY, because the Supabase JS client does not
// expose aggregation without an RPC, and at MVP scale the extra round-
// trip would cost more than the in-memory reduce. Fallback paths log
// via logServerError and degrade to an empty clusters array so callers
// don't 500 the whole UI.

// MV row shape the route fetches. Narrower than the full MV columns;
// pipelined through the pure `aggregateClusters` helper below.
type ObservationRow = ClusterObservationRow & { published_at: string | null }

const MAX_OBSERVATION_ROWS = 500
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const SAMPLES_PER_CLUSTER = 3

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  // Optional time-window filter aligned with /api/stats and
  // /api/classifications/stats — 0/missing = all time.
  const daysRaw = searchParams.get("days")
  const parsedDays = daysRaw !== null ? Number.parseInt(daysRaw, 10) : NaN
  const windowDays =
    Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : null
  const cutoffIso = windowDays
    ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
    : null

  // Caller-controlled cap on returned clusters; defaults to what the
  // chip strip displays.
  const limitRaw = searchParams.get("limit")
  const parsedLimit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : NaN
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT

  try {
    let obsQuery = supabase
      .from("mv_observation_current")
      .select(
        "observation_id, title, url, cluster_id, cluster_key, llm_classified_at, frequency_count, impact_score, sentiment, published_at",
      )
      .eq("is_canonical", true)
      .not("cluster_id", "is", null)
      .order("impact_score", { ascending: false })
      .limit(MAX_OBSERVATION_ROWS)
    if (cutoffIso) obsQuery = obsQuery.gte("published_at", cutoffIso)

    const { data: obsData, error: obsError } = await obsQuery

    if (obsError) {
      logServerError(
        "api-clusters",
        "observation_fetch_failed",
        obsError,
        { windowDays },
      )
      return NextResponse.json({ clusters: [], windowDays, source: "observations" })
    }

    const rows = (obsData ?? []) as ObservationRow[]
    if (rows.length === 0) {
      return NextResponse.json({ clusters: [], windowDays, source: "observations" })
    }

    // Fetch label + confidence for every surfaced cluster in one round
    // trip. Degrade gracefully if the label fetch fails — the chip
    // strip renders "Unlabelled cluster" as the placeholder in that
    // case. Label fetch is scoped to cluster_ids referenced by the
    // observation rows so we don't over-fetch.
    const clusterIds = Array.from(
      new Set(rows.map((r) => r.cluster_id).filter((v): v is string => Boolean(v))),
    )
    const { data: labelData, error: labelError } = clusterIds.length
      ? await supabase
          .from("clusters")
          .select("id, cluster_key, label, label_confidence")
          .in("id", clusterIds)
      : { data: [] as ClusterLabelRow[], error: null }

    if (labelError) {
      logServerError(
        "api-clusters",
        "cluster_label_fetch_failed",
        labelError,
        { cluster_id_count: clusterIds.length },
      )
    }

    const clusters = aggregateClusters(
      rows as ClusterObservationRow[],
      (labelData ?? []) as ClusterLabelRow[],
      { limit, samplesPerCluster: SAMPLES_PER_CLUSTER },
    )

    return NextResponse.json({
      clusters,
      windowDays,
      source: "observations",
    })
  } catch (error) {
    logServerError("api-clusters", "unexpected_error", error, { windowDays })
    return NextResponse.json(
      { clusters: [], windowDays, source: "observations" },
      { status: 200 },
    )
  }
}
