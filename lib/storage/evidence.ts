import type { createAdminClient } from "@/lib/supabase/admin"

// The only module permitted to write to the evidence layer.
// All writes route through SECURITY DEFINER RPCs; no direct INSERT/UPDATE.
// The evidence layer is append-only — existing rows are never mutated.
// See docs/ARCHITECTURE.md v10 §§3.1a, 5.1, 5.6.

type AdminClient = ReturnType<typeof createAdminClient>

export interface CapturedRecord {
  source_id: string
  external_id: string
  title: string
  content: string | null
  url: string | null
  // Normalized form of `url` — see lib/scrapers/url.ts. Null when the source
  // produced no URL or when the URL was unparseable. The migration in
  // scripts/030_observations_canonical_url.sql persists this onto
  // observations.canonical_url so the scraper's second-tier dedup can find
  // re-submissions under different external_ids.
  canonical_url: string | null
  author: string | null
  published_at: string | null
  upvotes: number
  comments_count: number
}

export async function recordObservation(
  supabase: AdminClient,
  record: CapturedRecord,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("record_observation", {
    payload: {
      source_id: record.source_id,
      external_id: record.external_id,
      title: record.title,
      content: record.content,
      url: record.url,
      canonical_url: record.canonical_url,
      author: record.author,
      published_at: record.published_at,
    },
  })
  if (error) {
    console.error("[evidence] record_observation failed:", error)
    return null
  }
  return data as string | null
}

export async function recordRevision(
  supabase: AdminClient,
  observationId: string,
  changes: { title?: string | null; content?: string | null; author?: string | null },
): Promise<string | null> {
  const { data, error } = await supabase.rpc("record_observation_revision", {
    obs_id: observationId,
    payload: {
      title: changes.title ?? null,
      content: changes.content ?? null,
      author: changes.author ?? null,
    },
  })
  if (error) {
    console.error("[evidence] record_observation_revision failed:", error)
    return null
  }
  return data as string | null
}

export async function recordEngagementSnapshot(
  supabase: AdminClient,
  observationId: string,
  upvotes: number,
  commentsCount: number,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("record_engagement_snapshot", {
    obs_id: observationId,
    upv: upvotes,
    cmts: commentsCount,
  })
  if (error) {
    console.error("[evidence] record_engagement_snapshot failed:", error)
    return null
  }
  return data as string | null
}

export interface DuplicateObservationMatch {
  observationId: string
  externalId: string
}

/**
 * Find an existing observation that matches `(source_id, canonical_url)` but
 * has a *different* `external_id` than the candidate. Returns null if no
 * match — the candidate is treated as a fresh submission and the regular
 * insert path proceeds.
 *
 * The match is the second-tier dedup signal: same source, same outbound
 * URL, but a fresh upstream submission ID. This is the case the
 * `(source_id, external_id)` PK cannot catch on its own (see
 * scripts/030_observations_canonical_url.sql for the full rationale).
 *
 * Re-scrapes of the same submission (`source_id` + `external_id` match)
 * are deliberately NOT treated as duplicates here — they go through the
 * normal `record_observation` upsert and become revision-stream updates.
 */
export async function findDuplicateByCanonicalUrl(
  supabase: AdminClient,
  args: { sourceId: string; canonicalUrl: string; externalId: string },
): Promise<DuplicateObservationMatch | null> {
  const { data, error } = await supabase
    .from("observations")
    .select("id, external_id")
    .eq("source_id", args.sourceId)
    .eq("canonical_url", args.canonicalUrl)
    .neq("external_id", args.externalId)
    .order("captured_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("[evidence] findDuplicateByCanonicalUrl failed:", error)
    return null
  }
  if (!data) return null
  return { observationId: data.id, externalId: data.external_id }
}

/**
 * Append a row to `duplicate_observation_events`. This is the visibility
 * mechanism for the second-tier dedup: every time we *would* have inserted
 * a duplicate but chose not to, we log the (source, canonical_url,
 * duplicate_external_id) triple so operators can quantify cross-stream
 * resubmission volume per source.
 */
export async function recordDuplicateObservationEvent(
  supabase: AdminClient,
  args: {
    sourceId: string
    canonicalUrl: string
    duplicateExternalId: string
    canonicalObservationId: string
  },
): Promise<void> {
  const { error } = await supabase.from("duplicate_observation_events").insert({
    source_id: args.sourceId,
    canonical_url: args.canonicalUrl,
    duplicate_external_id: args.duplicateExternalId,
    canonical_observation_id: args.canonicalObservationId,
  })
  if (error) {
    console.error("[evidence] recordDuplicateObservationEvent failed:", error)
  }
}

export async function recordIngestionArtifact(
  supabase: AdminClient,
  sourceId: string,
  externalId: string,
  fetchedAt: string,
  payload: unknown,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("record_ingestion_artifact", {
    src_id: sourceId,
    ext_id: externalId,
    fetched: fetchedAt,
    data: payload as any,
  })
  if (error) {
    console.error("[evidence] record_ingestion_artifact failed:", error)
    return null
  }
  return data as string | null
}
