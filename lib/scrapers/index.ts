import { createAdminClient } from "@/lib/supabase/admin"
import type { Issue, Source, Category, SentimentLabel } from "@/lib/types"
import { dedupeIssues } from "@/lib/scrapers/shared"
import { scrapeReddit } from "@/lib/scrapers/providers/reddit"
import { scrapeHackerNews } from "@/lib/scrapers/providers/hackernews"
import { scrapeGitHub } from "@/lib/scrapers/providers/github"
import { scrapeGitHubDiscussions } from "@/lib/scrapers/providers/github-discussions"
import { scrapeStackOverflow } from "@/lib/scrapers/providers/stackoverflow"
import { scrapeOpenAICommunity } from "@/lib/scrapers/providers/openai-community"
import {
  recordObservation,
  recordEngagementSnapshot,
  recordRevision,
  recordIngestionArtifact,
} from "@/lib/storage/evidence"
import {
  recordSentiment,
  recordCategory,
  recordImpact,
  recordBugFingerprint,
} from "@/lib/storage/derivations"
import { runSemanticClusteringForBatch } from "@/lib/storage/semantic-clusters"
import { recordProcessingEvent } from "@/lib/storage/processing-events"
import {
  processObservationClassificationQueue,
  synthesizeObservationReportText,
  type ClassificationCandidate,
} from "@/lib/classification/pipeline"
import {
  buildEnvFromFingerprintColumns,
  buildReproFromFingerprintMarkers,
} from "@/lib/classification/candidate"
import {
  extractBugFingerprint,
  buildCompoundClusterKey,
  type BugFingerprint,
} from "@/lib/scrapers/bug-fingerprint"

export {
  scrapeReddit,
  scrapeHackerNews,
  scrapeGitHub,
  scrapeGitHubDiscussions,
  scrapeStackOverflow,
  scrapeOpenAICommunity,
}
export * from "@/lib/scrapers/shared"

type Scraper = (s: Source, c: Category[]) => Promise<Partial<Issue>[]>

const SCRAPERS: Record<string, Scraper> = {
  reddit: scrapeReddit,
  hackernews: scrapeHackerNews,
  github: scrapeGitHub,
  "github-discussions": scrapeGitHubDiscussions,
  stackoverflow: scrapeStackOverflow,
  "openai-community": scrapeOpenAICommunity,
}

interface RunSummary {
  total: number
  added: number
  errors: string[]
  bySource: Array<{ source: string; found: number; added: number; status: "success" | "error"; error?: string }>
}

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Persist one captured issue across the three layers:
 * 1. evidence (observation + revision if title/content changed +
 *    engagement snapshot + raw upstream artifact)
 * 2. derivation (sentiment, category, impact)
 * 3. aggregation (cluster membership)
 *
 * Each write is a SECURITY DEFINER RPC; no direct table mutation.
 * Failure of any derivation/cluster write does not undo the evidence
 * insert — raw capture is independent of enrichment correctness.
 *
 * Revision detection: before recording the observation, SELECT the
 * existing row (if any). If title/content/author have diverged from
 * what we just captured, append to observation_revisions. The
 * observation row itself is never updated.
 */
async function persistIssueRecord(
  supabase: AdminClient,
  issue: Partial<Issue>,
): Promise<{
  observationId: string
  title: string
  reportText: string
  isNewObservation: boolean
  fingerprint: BugFingerprint
} | null> {
  if (!issue.source_id || !issue.external_id || !issue.title) return null

  // 3.1a Evidence — detect pre-existing observation so we can distinguish
  // "first sighting" from "rescrape with edits". Select before insert so
  // the diff is computed against the frozen original.
  const { data: existing } = await supabase
    .from("observations")
    .select("id, title, content, author")
    .eq("source_id", issue.source_id)
    .eq("external_id", issue.external_id)
    .maybeSingle()

  const observationId = await recordObservation(supabase, {
    source_id: issue.source_id,
    external_id: issue.external_id,
    title: issue.title,
    content: issue.content ?? null,
    url: issue.url ?? null,
    author: issue.author ?? null,
    published_at: issue.published_at ?? null,
    upvotes: issue.upvotes ?? 0,
    comments_count: issue.comments_count ?? 0,
  })
  if (!observationId) return null

  // Revision capture: if the observation already existed and any of
  // title/content/author have changed, append to observation_revisions.
  // observations.title/content are frozen at first capture (P1-10 fix).
  if (existing) {
    const titleChanged = (existing.title ?? null) !== (issue.title ?? null)
    const contentChanged = (existing.content ?? null) !== (issue.content ?? null)
    const authorChanged = (existing.author ?? null) !== (issue.author ?? null)
    if (titleChanged || contentChanged || authorChanged) {
      await recordRevision(supabase, observationId, {
        title: issue.title ?? null,
        content: issue.content ?? null,
        author: issue.author ?? null,
      })
    }
  }

  // Engagement snapshot — append every time; the time series is the point.
  await recordEngagementSnapshot(
    supabase,
    observationId,
    issue.upvotes ?? 0,
    issue.comments_count ?? 0,
  )

  // Ingestion artifact — opt-in via provider `_raw`. Providers that don't
  // set _raw skip this step; artifact capture is per-provider retrofit.
  if (issue._raw !== undefined) {
    await recordIngestionArtifact(
      supabase,
      issue.source_id,
      issue.external_id,
      new Date().toISOString(),
      issue._raw,
    )
  }

  // 3.1b Derivation
  if (issue.sentiment) {
    await recordSentiment(supabase, observationId, {
      label: issue.sentiment as SentimentLabel,
      score: issue.sentiment_score ?? 0,
      keyword_presence: issue.keyword_presence ?? 0,
    })
  }
  if (issue.category_id) {
    await recordCategory(supabase, observationId, issue.category_id, 1.0)
  }
  if (typeof issue.impact_score === "number") {
    // inputs_jsonb must be complete enough to recompute the impact score
    // from captured evidence alone (ARCHITECTURE §3.1b). impact v2 adds
    // source_slug as a scoring input (authority multiplier), so it is
    // persisted here — otherwise a v2 row couldn't be replayed without
    // joining observations → sources.
    await recordImpact(supabase, observationId, issue.impact_score, {
      upvotes: issue.upvotes ?? 0,
      comments_count: issue.comments_count ?? 0,
      sentiment_label: (issue.sentiment ?? "neutral") as SentimentLabel,
      source_slug: issue.source_slug ?? null,
    })
  }

  // 3.1b bug-fingerprint derivation.
  //
  // Deterministic regex extractor that pulls concrete differentiators
  // (error codes, top stack frame, CLI version, OS, model id, repro
  // markers, keyword_presence) out of title + body. The fingerprint is
  // *intentionally decoupled* from the semantic clustering pass below:
  //   * Semantic clustering answers "which reports are about the same
  //     thing?" — conceptual grouping via embeddings.
  //   * The fingerprint answers "what exactly differs between reports
  //     that sound alike?" — a sub-cluster label inside a semantic
  //     bucket (e.g. ENOENT vs EACCES crashes on startup).
  // The compound cluster-key label (title|err|frame) is stored on the
  // fingerprint row as a durable audit trail. It is the backbone of the
  // regex-first "layer 2" in the SignalLayers UI; the classifier LLM
  // pass below becomes "layer 3".
  const fingerprint = extractBugFingerprint({
    title: issue.title,
    content: issue.content ?? null,
  })
  const compoundKey = buildCompoundClusterKey(issue.title, fingerprint)
  await recordBugFingerprint(supabase, observationId, {
    ...fingerprint,
    cluster_key_compound: compoundKey,
  })
  await recordProcessingEvent(supabase, {
    observationId,
    stage: "fingerprinting",
    status: "completed",
    algorithmVersionModel: "regex:v1",
    detail: {
      error_code: fingerprint.error_code,
      top_stack_frame_hash: fingerprint.top_stack_frame_hash,
      cluster_key_compound: compoundKey,
    },
  })

  // 3.1c Aggregation — semantic clustering first (embeddings ⇒ attach,
  // title-hash fallback on failure). Fingerprint sub-clustering is a
  // read-time concern today: the SignalLayers panel groups cluster
  // members by `error_code` + `top_stack_frame_hash` client-side so
  // analysts see the sub-structure without the writer needing to create
  // physical sub-clusters. If we later decide to promote sub-clusters
  // to their own rows, the compound key above is the deterministic
  // split function.
  await runSemanticClusteringForBatch(
    supabase,
    [
      {
        id: observationId,
        title: issue.title,
        content: issue.content ?? null,
        // Topic + error code feed the deterministic fallback labeller
        // and prompt context (lib/storage/cluster-label-fallback.ts).
        // Both are nullable: not every provider surfaces a Topic, and
        // not every issue has a regex-extractable error code.
        topicSlug: issue.category?.slug ?? null,
        errorCode: fingerprint.error_code ?? null,
      },
    ],
    { minClusterSize: 2 },
  )

  return {
    observationId,
    title: issue.title,
    reportText: synthesizeObservationReportText({
      title: issue.title,
      content: issue.content ?? null,
      url: issue.url ?? null,
      sourceSlug: issue.source_slug ?? null,
    }),
    isNewObservation: !existing,
    fingerprint,
  }
}

// Build a ClassificationCandidate that forwards regex-derived env + repro
// context (outcome C). Keeping this in one place so both runAllScrapers
// and runScraper wire identical payloads into the queue. The actual env
// + repro extraction rules live in lib/classification/candidate.ts so
// the daily backfill cron's mv-row-based path uses the same logic.
function buildClassificationCandidate(persisted: {
  observationId: string
  title: string
  reportText: string
  fingerprint: BugFingerprint
}): ClassificationCandidate {
  const fp = persisted.fingerprint
  return {
    observationId: persisted.observationId,
    title: persisted.title,
    reportText: persisted.reportText,
    env: buildEnvFromFingerprintColumns({
      cli_version: fp.cli_version,
      os: fp.os,
      shell: fp.shell,
      editor: fp.editor,
      model_id: fp.model_id,
    }),
    repro: buildReproFromFingerprintMarkers(fp.repro_markers),
  }
}

async function refreshMaterializedViews(supabase: AdminClient): Promise<void> {
  const { error } = await supabase.rpc("refresh_materialized_views")
  if (error) console.error("[cron] refresh_materialized_views failed:", error)
}

export async function runAllScrapers(): Promise<RunSummary> {
  const supabase = createAdminClient()
  const errors: string[] = []
  const bySource: RunSummary["bySource"] = []
  const classificationCandidates: ClassificationCandidate[] = []
  let totalFound = 0
  let totalAdded = 0

  const { data: sources } = await supabase.from("sources").select("*")
  const { data: categories } = await supabase.from("categories").select("*")

  if (!sources || !categories) {
    return {
      total: 0,
      added: 0,
      errors: ["Failed to load sources/categories"],
      bySource: [],
    }
  }

  const sourceRuns = sources
    .filter((source: Source) => SCRAPERS[source.slug])
    .map(async (source: Source) => {
      const scraper = SCRAPERS[source.slug]

      const { data: log } = await supabase
        .from("scrape_logs")
        .insert({ source_id: source.id, status: "running" })
        .select()
        .single()

      try {
        const issues = dedupeIssues(await scraper(source, categories))
        let added = 0

        for (const issue of issues) {
          const persisted = await persistIssueRecord(supabase, issue)
          if (persisted) {
            added++
            if (persisted.isNewObservation) {
              classificationCandidates.push(buildClassificationCandidate(persisted))
            }
          }
        }

        if (log) {
          await supabase
            .from("scrape_logs")
            .update({
              status: "completed",
              issues_found: issues.length,
              issues_added: added,
              completed_at: new Date().toISOString(),
            })
            .eq("id", log.id)
        }

        totalFound += issues.length
        totalAdded += added
        bySource.push({
          source: source.slug,
          found: issues.length,
          added,
          status: "success",
        })
      } catch (error) {
        const errorMsg = `Error scraping ${source.name}: ${error instanceof Error ? error.message : String(error)}`
        errors.push(errorMsg)

        if (log) {
          await supabase
            .from("scrape_logs")
            .update({
              status: "failed",
              error_message: errorMsg,
              completed_at: new Date().toISOString(),
            })
            .eq("id", log.id)
        }

        bySource.push({
          source: source.slug,
          found: 0,
          added: 0,
          status: "error",
          error: errorMsg,
        })
      }
    })

  await Promise.all(sourceRuns)

  const classificationResults = await processObservationClassificationQueue(
    supabase,
    classificationCandidates,
  )
  errors.push(
    ...classificationResults.failures.map(
      (failure) =>
        `Classification failed for observation ${failure.observationId} (${failure.title}): ${failure.reason}`,
    ),
  )

  // Rebuild materialized views at cron end so the dashboard picks up the new
  // scrape in one step. See docs/ARCHITECTURE.md v10 §3.1c.
  await refreshMaterializedViews(supabase)

  return { total: totalFound, added: totalAdded, errors, bySource }
}

export async function runScraper(slug: string): Promise<RunSummary> {
  const supabase = createAdminClient()

  const { data: sources } = await supabase
    .from("sources")
    .select("*")
    .eq("slug", slug)
    .limit(1)
  const { data: categories } = await supabase.from("categories").select("*")

  if (!sources || sources.length === 0 || !categories) {
    return {
      total: 0,
      added: 0,
      errors: [`Source not found: ${slug}`],
      bySource: [],
    }
  }

  const source = sources[0] as Source
  const scraper = SCRAPERS[source.slug]
  if (!scraper) {
    return {
      total: 0,
      added: 0,
      errors: [`No scraper registered for source: ${slug}`],
      bySource: [],
    }
  }

  const issues = dedupeIssues(await scraper(source, categories))
  let added = 0
  const classificationCandidates: ClassificationCandidate[] = []
  for (const issue of issues) {
    const persisted = await persistIssueRecord(supabase, issue)
    if (persisted) {
      added++
      if (persisted.isNewObservation) {
        classificationCandidates.push(buildClassificationCandidate(persisted))
      }
    }
  }

  const classificationResults = await processObservationClassificationQueue(
    supabase,
    classificationCandidates,
  )

  await refreshMaterializedViews(supabase)

  return {
    total: issues.length,
    added,
    errors: classificationResults.failures.map(
      (failure) =>
        `Classification failed for observation ${failure.observationId} (${failure.title}): ${failure.reason}`,
    ),
    bySource: [{ source: source.slug, found: issues.length, added, status: "success" }],
  }
}
