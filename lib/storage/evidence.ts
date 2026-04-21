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
