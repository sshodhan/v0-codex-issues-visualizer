/**
 * Expected `public`-schema state after migration 014.
 *
 * The admin "Schema verification" tab calls `get_schema_snapshot()`
 * (added by 015) and diffs the live snapshot against this manifest.
 *
 * Maintenance contract:
 *   * Each new SQL migration in scripts/ must update this file in the
 *     same PR. The verifier surfaces drift on the admin page, so a
 *     forgotten update shows up immediately, not in production.
 *   * `requiredColumns` is an allow-list of the few columns whose
 *     presence proves a specific migration ran. Listing every column
 *     would be churn-heavy and adds no signal — the per-migration
 *     "did this run" answer needs only one column from each.
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
    // 013.
    "record_bug_fingerprint",
    // 014.
    "fingerprint_surges",
    // 015 (this migration).
    "get_schema_snapshot",
  ],
  indexes: [
    // 007 — uniqueness needed for `refresh ... concurrently` on mv_observation_current.
    "idx_mv_observation_current_canonical",
    "idx_mv_observation_current_cluster",
    "idx_mv_trend_daily_day",
    // 007 — partial unique guarding "one current per kind".
    "idx_algorithm_versions_one_current",
    // 013.
    "idx_mv_observation_current_error_code",
    "idx_mv_observation_current_frame_hash",
    "idx_bug_fingerprints_latest",
    "idx_bug_fingerprints_error_code",
    "idx_bug_fingerprints_frame_hash",
    // 014 — the unique index is the prereq for `refresh ... concurrently`
    // mentioned in the migration header.
    "idx_mv_fingerprint_daily_day_code",
    "idx_mv_fingerprint_daily_code_day",
    "idx_mv_fingerprint_daily_day",
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
    // 012 added embeddings table — verify shape, not just existence.
    observation_embeddings: ["observation_id", "embedding_vector", "model"],
    // 013 added the fingerprint payload shape.
    bug_fingerprints: [
      "observation_id",
      "algorithm_version",
      "error_code",
      "frame_hash",
      "compound_cluster_key",
    ],
    // 007 invariants: scrape_logs status check + completed_at sentinel.
    scrape_logs: ["status", "started_at", "completed_at"],
    // 007 evidence-layer shape.
    observations: ["external_id", "source_id", "captured_at", "published_at"],
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
    // 011 flipped these to v2.
    sentiment: "v2",
    category: "v2",
    impact: "v2",
    competitor_mention: "v2",
    // Classification stays at v1 (011 doesn't bump it).
    classification: "v1",
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

function tableGroup(name: string): string {
  if (
    [
      "observations",
      "observation_revisions",
      "engagement_snapshots",
      "ingestion_artifacts",
    ].includes(name)
  ) {
    return "evidence"
  }
  if (
    [
      "sentiment_scores",
      "category_assignments",
      "impact_scores",
      "competitor_mentions",
    ].includes(name)
  ) {
    return "derivation"
  }
  if (["classifications", "classification_reviews"].includes(name)) {
    return "classification"
  }
  if (
    [
      "clusters",
      "cluster_members",
      "observation_embeddings",
      "cluster_frequency",
      "v_cluster_source_diversity",
    ].includes(name)
  ) {
    return "clustering"
  }
  if (["bug_fingerprints", "mv_fingerprint_daily"].includes(name)) {
    return "fingerprints"
  }
  if (
    [
      "mv_observation_current",
      "mv_trend_daily",
      "refresh_materialized_views",
    ].includes(name)
  ) {
    return "aggregation"
  }
  if (["sources", "categories", "scrape_logs", "algorithm_versions"].includes(name)) {
    return "reference"
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
      group: tableGroup(i.replace(/^idx_/, "").split("_")[0] ?? ""),
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
