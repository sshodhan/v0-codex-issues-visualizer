/**
 * Expected `public`-schema state after migration 016 (cluster health read model).
 *
 * The admin "Schema verification" tab calls `get_schema_snapshot()`
 * (added by 015) and diffs the live snapshot against this manifest.
 *
 * The contents below were reconciled against a live ground-truth
 * snapshot (pg_catalog + information_schema) — not derived from
 * reading the migration files alone. Reading the SQL had two real
 * failure modes that the live snapshot caught:
 *   1. column names: `bug_fingerprints` actually has
 *      `top_stack_frame_hash` and `cluster_key_compound`, not the
 *      `frame_hash` / `compound_cluster_key` an earlier draft
 *      assumed. Same for `observation_embeddings.vector`.
 *   2. drop-cascade fallout: 013 drops + recreates
 *      `mv_observation_current` from scratch, which silently took
 *      010's perf indexes (idx_mv_observation_current_impact,
 *      _upvotes, _comments, _sentiment_score, _captured_at,
 *      _title_trgm, _content_trgm) with it. They are not in the
 *      live DB and so are not in this manifest.
 *
 * Maintenance contract:
 *   * Each new SQL migration in scripts/ must update this file in the
 *     same PR. The verifier surfaces drift on the admin page, so a
 *     forgotten update shows up immediately, not in production.
 *   * After a destructive migration (drop + recreate of a table or
 *     MV), re-run the snapshot SQL and reconcile this file — do not
 *     rely on reading the SQL.
 *   * `requiredColumns` is an allow-list of the few columns whose
 *     presence proves a specific migration ran. Listing every column
 *     would be churn-heavy and adds no signal.
 *   * `forbidden*` lists things that earlier migrations dropped.
 *     A residual `bug_report_classifications` table after running
 *     007 means the drop didn't happen — that's a real failure, not
 *     a no-op.
 */

export type CheckKind =
  | "table"
  | "view"
  | "matview"
  | "index"
  | "function"
  | "column"
  | "algorithm_version"

export interface SchemaSnapshot {
  tables: string[]
  views: string[]
  matviews: string[]
  indexes: string[]
  functions: string[]
  columns: Record<string, string[]>
  algorithm_versions_current: Record<string, string>
  snapshot_at: string
}

export interface ExpectedManifest {
  tables: string[]
  views: string[]
  matviews: string[]
  functions: string[]
  /** Indexes whose absence breaks a known query path (MV refresh, MV
   * filters, fingerprint lookups). Not exhaustive — adding here is
   * deliberate. */
  indexes: string[]
  /** Per-table allow-list of columns that prove specific migrations
   * landed. Tables not listed here only get an existence check. */
  requiredColumns: Record<string, string[]>
  /** Objects earlier migrations dropped. Verifier flags any of these
   * still present as a failure. */
  forbiddenTables: string[]
  forbiddenMatviews: string[]
  /** Algorithm-version registry rows that should be `current_effective`
   * after migration 011. */
  expectedCurrentAlgorithmVersions: Record<string, string>
}

export const EXPECTED_MANIFEST: ExpectedManifest = {
  tables: [
    // Reference (007).
    "sources",
    "categories",
    "scrape_logs",
    "algorithm_versions",
    // Evidence layer (007).
    "observations",
    "observation_revisions",
    "engagement_snapshots",
    "ingestion_artifacts",
    // Derivation layer (007).
    "sentiment_scores",
    "category_assignments",
    "impact_scores",
    "competitor_mentions",
    // Classification (007).
    "classifications",
    "classification_reviews",
    // Aggregation / clustering (007).
    "clusters",
    "cluster_members",
    // Embeddings (012).
    "observation_embeddings",
    // Bug fingerprints (013).
    "bug_fingerprints",
    // Processing trace events (017).
    "processing_events",
  ],
  views: [
    // 007: cluster_frequency = view over cluster_members.
    "cluster_frequency",
    // 014.
    "v_cluster_source_diversity",
  ],
  matviews: [
    // Recreated in 013 with bug-fingerprint columns folded in.
    "mv_observation_current",
    "mv_trend_daily",
    // 014.
    "mv_fingerprint_daily",
    // 016.
    "mv_cluster_health_current",
    // 027.
    "mv_cluster_topic_metadata",
  ],
  functions: [
    // 007 — write/read RPCs the scraper pipeline depends on.
    "refresh_materialized_views",
    "record_observation",
    "record_observation_revision",
    "record_engagement_snapshot",
    "record_ingestion_artifact",
    "record_sentiment",
    "record_category",
    "record_impact",
    "record_competitor_mention",
    "record_classification",
    "record_classification_review",
    "attach_to_cluster",
    "detach_from_cluster",
    // 009.
    "observation_current_as_of",
    // 012 — embedding writer + cluster-label setter.
    "record_observation_embedding",
    "set_cluster_label",
    // 013.
    "record_bug_fingerprint",
    // 014.
    "fingerprint_surges",
    // 015.
    "get_schema_snapshot",
  ],
  indexes: [
    // ---- evidence layer (007) ----
    "idx_observations_published_at",
    "idx_observations_captured_at",
    "idx_observations_source",
    "idx_observation_revisions_obs",
    "idx_engagement_snapshots_latest",
    "idx_ingestion_artifacts_lookup",
    // ---- derivation layer (007) ----
    "idx_sentiment_latest",
    "idx_category_latest",
    "idx_impact_latest",
    "idx_competitor_mentions_obs",
    "idx_competitor_mentions_roll",
    // ---- classification (007) ----
    "idx_classifications_obs",
    "idx_classifications_triage",
    "idx_classifications_prior",
    "idx_classification_reviews_latest",
    // ---- clustering (007 + hand-added active-membership unique) ----
    "idx_cluster_members_obs",
    "idx_cluster_members_active",
    // ---- embeddings (012) ----
    "idx_observation_embeddings_obs",
    // ---- bug fingerprints (013) ----
    "idx_bug_fingerprints_latest",
    "idx_bug_fingerprints_error_code",
    "idx_bug_fingerprints_frame_hash",
    // ---- mv_observation_current (013 recreate) ----
    // idx_mv_observation_current_pk is the UNIQUE index on
    // observation_id; it is the prerequisite for the
    // `REFRESH MATERIALIZED VIEW CONCURRENTLY` that
    // `refresh_materialized_views()` runs on every cron tick.
    // Drop it and the cron starts taking exclusive locks.
    "idx_mv_observation_current_pk",
    "idx_mv_observation_current_canonical",
    "idx_mv_observation_current_cluster",
    "idx_mv_observation_current_error_code",
    "idx_mv_observation_current_frame_hash",
    // ---- mv_trend_daily (007/013) ----
    "idx_mv_trend_daily_day",
    // ---- mv_fingerprint_daily (014) — unique index gates concurrent refresh ----
    "idx_mv_fingerprint_daily_day_code",
    "idx_mv_fingerprint_daily_code_day",
    "idx_mv_fingerprint_daily_day",
    // ---- mv_cluster_health_current (016) ----
    "idx_mv_cluster_health_current_cluster",
    "idx_mv_cluster_health_current_size",
    // ---- mv_cluster_topic_metadata (027) ----
    "idx_mv_cluster_topic_metadata_cluster",
    "idx_mv_cluster_topic_metadata_mixed",
    "idx_mv_cluster_topic_metadata_dominant",
    // ---- algorithm registry (007) ----
    "idx_algorithm_versions_one_current",
    // ---- scrape logs (002 + hand-added status filter) ----
    "idx_scrape_logs_source",
    "idx_scrape_logs_status",
    // ---- processing events (017) ----
    "idx_processing_events_observation_created",
    "idx_processing_events_stage_created",
  ],
  requiredColumns: {
    // 012 added cluster-labeling columns.
    clusters: [
      "label",
      "label_rationale",
      "label_confidence",
      "label_model",
      "label_algorithm_version",
      "labeling_updated_at",
    ],
    // 012 — embeddings table shape. Live column is `vector` (not
    // `embedding_vector`); `dimensions` and `input_text` are part of
    // the on-disk shape too and worth nailing down.
    observation_embeddings: [
      "observation_id",
      "algorithm_version",
      "model",
      "dimensions",
      "input_text",
      "vector",
    ],
    // 013 — fingerprint payload. Real names are
    // `top_stack_frame_hash` and `cluster_key_compound`; the
    // earlier draft of this manifest had `frame_hash` and
    // `compound_cluster_key`, which would have produced false
    // failures forever.
    bug_fingerprints: [
      "observation_id",
      "algorithm_version",
      "error_code",
      "top_stack_frame",
      "top_stack_frame_hash",
      "cli_version",
      "os",
      "shell",
      "editor",
      "model_id",
      "repro_markers",
      "keyword_presence",
      "cluster_key_compound",
    ],
    // 007 invariants: scrape_logs status check + completed_at sentinel.
    scrape_logs: ["status", "started_at", "completed_at"],
    // 007 evidence-layer shape.
    observations: ["external_id", "source_id", "captured_at", "published_at"],
    processing_events: [
      "observation_id",
      "stage",
      "status",
      "algorithm_version_model",
      "detail_json",
      "created_at",
    ],
  },
  forbiddenTables: [
    // 003 created, 007 dropped.
    "bug_report_classifications",
    // Pre-007 monolith — replaced by `observations` + derivation tables.
    "issues",
  ],
  forbiddenMatviews: [
    // 007 explicitly drops this; nothing later recreates it.
    "mv_dashboard_stats",
  ],
  expectedCurrentAlgorithmVersions: {
    // 011 flipped these four to v2. If the live registry still
    // shows v1, that's the verifier surfacing an unapplied
    // migration — apply scripts/011_algorithm_v2_bump.sql.
    sentiment: "v2",
    // 025 bumped category to v5 (structural classifier fixes); 027
    // bumped to v6 (phrase-table maintenance pass — added/removed
    // phrases per low-margin review, no architecture change). If the
    // live registry still shows v4 or v5, apply scripts/025–027 in
    // order.
    category: "v6",
    impact: "v2",
    competitor_mention: "v2",
    // Classification stays at v1 (011 doesn't bump it).
    classification: "v1",
    // 012 added these two registry kinds.
    observation_embedding: "v1",
    // Bumped v1 → v2 alongside the deterministic-fallback labeller in
    // lib/storage/cluster-label-fallback.ts (Topic+error fallback,
    // small→large LLM escalation). See lib/storage/algorithm-versions.ts
    // and docs/CLUSTERING_DESIGN.md §4.4. A live registry still showing
    // v1 means the algorithm_versions seed row hasn't been re-applied;
    // re-run the seed migration that touches semantic_cluster_label.
    semantic_cluster_label: "v2",
    // 013 added this one.
    bug_fingerprint: "v1",
  },
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type Status = "pass" | "fail"

export interface CheckResult {
  kind: CheckKind
  name: string
  /** Short human-readable expected state, e.g. "exists", "absent",
   * "current_effective = v2". */
  expected: string
  actual: string
  status: Status
  /** Optional grouping label for the UI ("evidence", "derivation",
   * "fingerprints", …). Inferred per-check below. */
  group?: string
}

export interface VerifyReport {
  snapshotAt: string
  summary: { total: number; pass: number; fail: number }
  checks: CheckResult[]
}

// Maps a table/view/MV/index/function name to a stable architectural
// group label so the UI can cluster failures by layer instead of by
// kind. Pattern-based to cover index and function names that share a
// prefix with the table they belong to (idx_observations_*, etc.).
function tableGroup(name: string): string {
  // Aggregation MVs (and the refresh function) come first because
  // their names overlap with several other layers — match before the
  // per-table fallthroughs below.
  if (
    name === "mv_observation_current" ||
    name === "mv_trend_daily" ||
    name === "refresh_materialized_views" ||
    name.startsWith("idx_mv_observation_current") ||
    name.startsWith("idx_mv_trend_daily")
  ) {
    return "aggregation"
  }
  if (
    name === "bug_fingerprints" ||
    name === "mv_fingerprint_daily" ||
    name === "fingerprint_surges" ||
    name === "record_bug_fingerprint" ||
    name.startsWith("idx_bug_fingerprints") ||
    name.startsWith("idx_mv_fingerprint_daily")
  ) {
    return "fingerprints"
  }
  if (
    name === "observations" ||
    name === "observation_revisions" ||
    name === "engagement_snapshots" ||
    name === "ingestion_artifacts" ||
    name === "record_observation" ||
    name === "record_observation_revision" ||
    name === "record_engagement_snapshot" ||
    name === "record_ingestion_artifact" ||
    name === "observation_current_as_of" ||
    name.startsWith("idx_observations") ||
    name.startsWith("idx_observation_revisions") ||
    name.startsWith("idx_engagement_snapshots") ||
    name.startsWith("idx_ingestion_artifacts")
  ) {
    return "evidence"
  }
  if (
    name === "sentiment_scores" ||
    name === "category_assignments" ||
    name === "impact_scores" ||
    name === "competitor_mentions" ||
    name === "record_sentiment" ||
    name === "record_category" ||
    name === "record_impact" ||
    name === "record_competitor_mention" ||
    name.startsWith("idx_sentiment") ||
    name.startsWith("idx_category") ||
    name.startsWith("idx_impact") ||
    name.startsWith("idx_competitor_mentions")
  ) {
    return "derivation"
  }
  if (
    name === "classifications" ||
    name === "classification_reviews" ||
    name === "record_classification" ||
    name === "record_classification_review" ||
    name.startsWith("idx_classifications") ||
    name.startsWith("idx_classification_reviews")
  ) {
    return "classification"
  }
  if (
    name === "clusters" ||
    name === "cluster_members" ||
    name === "observation_embeddings" ||
    name === "cluster_frequency" ||
    name === "v_cluster_source_diversity" ||
    name === "mv_cluster_health_current" ||
    name === "mv_cluster_topic_metadata" ||
    name === "attach_to_cluster" ||
    name === "detach_from_cluster" ||
    name === "set_cluster_label" ||
    name === "record_observation_embedding" ||
    name.startsWith("idx_cluster_members") ||
    name.startsWith("idx_observation_embeddings") ||
    name.startsWith("idx_mv_cluster_health_current") ||
    name.startsWith("idx_mv_cluster_topic_metadata")
  ) {
    return "clustering"
  }
  if (
    name === "sources" ||
    name === "categories" ||
    name === "scrape_logs" ||
    name === "algorithm_versions" ||
    name.startsWith("idx_scrape_logs") ||
    name.startsWith("idx_algorithm_versions")
  ) {
    return "reference"
  }
  if (name === "get_schema_snapshot") {
    return "verifier"
  }
  return "other"
}

export function diffSnapshot(
  snapshot: SchemaSnapshot,
  manifest: ExpectedManifest = EXPECTED_MANIFEST,
): VerifyReport {
  const checks: CheckResult[] = []

  const has = (haystack: string[], needle: string) => haystack.includes(needle)

  for (const t of manifest.tables) {
    const present = has(snapshot.tables, t)
    checks.push({
      kind: "table",
      name: t,
      expected: "exists",
      actual: present ? "exists" : "missing",
      status: present ? "pass" : "fail",
      group: tableGroup(t),
    })
  }

  for (const v of manifest.views) {
    const present = has(snapshot.views, v)
    checks.push({
      kind: "view",
      name: v,
      expected: "exists",
      actual: present ? "exists" : "missing",
      status: present ? "pass" : "fail",
      group: tableGroup(v),
    })
  }

  for (const m of manifest.matviews) {
    const present = has(snapshot.matviews, m)
    checks.push({
      kind: "matview",
      name: m,
      expected: "exists",
      actual: present ? "exists" : "missing",
      status: present ? "pass" : "fail",
      group: tableGroup(m),
    })
  }

  for (const i of manifest.indexes) {
    const present = has(snapshot.indexes, i)
    checks.push({
      kind: "index",
      name: i,
      expected: "exists",
      actual: present ? "exists" : "missing",
      status: present ? "pass" : "fail",
      group: tableGroup(i),
    })
  }

  for (const f of manifest.functions) {
    const present = has(snapshot.functions, f)
    checks.push({
      kind: "function",
      name: f,
      expected: "exists",
      actual: present ? "exists" : "missing",
      status: present ? "pass" : "fail",
      group: tableGroup(f),
    })
  }

  for (const [table, requiredCols] of Object.entries(manifest.requiredColumns)) {
    const actualCols = snapshot.columns[table] ?? []
    for (const col of requiredCols) {
      const present = actualCols.includes(col)
      checks.push({
        kind: "column",
        name: `${table}.${col}`,
        expected: "exists",
        actual: present ? "exists" : "missing",
        status: present ? "pass" : "fail",
        group: tableGroup(table),
      })
    }
  }

  for (const t of manifest.forbiddenTables) {
    const present = has(snapshot.tables, t)
    checks.push({
      kind: "table",
      name: t,
      expected: "absent (dropped by earlier migration)",
      actual: present ? "exists" : "absent",
      status: present ? "fail" : "pass",
      group: "dropped",
    })
  }

  for (const m of manifest.forbiddenMatviews) {
    const present = has(snapshot.matviews, m)
    checks.push({
      kind: "matview",
      name: m,
      expected: "absent (dropped by earlier migration)",
      actual: present ? "exists" : "absent",
      status: present ? "fail" : "pass",
      group: "dropped",
    })
  }

  for (const [kind, expectedVersion] of Object.entries(
    manifest.expectedCurrentAlgorithmVersions,
  )) {
    const actualVersion = snapshot.algorithm_versions_current[kind]
    const ok = actualVersion === expectedVersion
    checks.push({
      kind: "algorithm_version",
      name: kind,
      expected: `current_effective = ${expectedVersion}`,
      actual: actualVersion ? `current_effective = ${actualVersion}` : "no current row",
      status: ok ? "pass" : "fail",
      group: "algorithm",
    })
  }

  const pass = checks.filter((c) => c.status === "pass").length
  const fail = checks.length - pass
  return {
    snapshotAt: snapshot.snapshot_at,
    summary: { total: checks.length, pass, fail },
    checks,
  }
}
