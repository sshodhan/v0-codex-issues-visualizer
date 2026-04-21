import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// The evidence layer must be append-only. This test enforces the invariant
// at the code level: no file in lib/ or app/ may issue an UPDATE or DELETE
// against any evidence table. Writes to evidence flow exclusively through
// SECURITY DEFINER RPCs in scripts/007_three_layer_split.sql.
//
// Belt-and-braces: scripts/008_revoke_service_role_dml.sql revokes direct
// INSERT/UPDATE/DELETE from service_role at the DB layer, so even a
// compromised or misconfigured client cannot mutate evidence rows. The
// third test below asserts the 008 migration contains those REVOKEs.
//
// See docs/ARCHITECTURE.md v10 §§5.1, 5.6, 6.5.

const EVIDENCE_TABLES = [
  "observations",
  "observation_revisions",
  "engagement_snapshots",
  "ingestion_artifacts",
]

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

async function collectSourceFiles(root: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises")
  const files: string[] = []

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue
        await walk(full)
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        files.push(full)
      }
    }
  }

  await walk(join(root, "lib"))
  await walk(join(root, "app"))
  return files
}

test("no evidence-table mutations outside of SECURITY DEFINER RPCs", async () => {
  const files = await collectSourceFiles(repoRoot)
  const offenders: Array<{ file: string; line: number; text: string }> = []

  for (const file of files) {
    const content = readFileSync(file, "utf8")
    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const table of EVIDENCE_TABLES) {
        const updatePattern = new RegExp(`\\.from\\(["']${table}["']\\)[\\s\\S]{0,120}\\.(update|delete)\\b`)
        if (updatePattern.test(line)) {
          offenders.push({ file: file.replace(repoRoot + "/", ""), line: i + 1, text: line.trim() })
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Evidence-layer append-only invariant violated:\n${offenders
      .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
      .join("\n")}`,
  )
})

test("lib/storage/evidence.ts is the sole module that touches evidence RPCs", async () => {
  const { readdir } = await import("node:fs/promises")
  const EVIDENCE_RPCS = [
    "record_observation",
    "record_observation_revision",
    "record_engagement_snapshot",
    "record_ingestion_artifact",
  ]
  const files = await collectSourceFiles(repoRoot)
  const allowlist = ["lib/storage/evidence.ts", "tests/evidence-append-only.test.ts"]

  for (const file of files) {
    const content = readFileSync(file, "utf8")
    for (const rpc of EVIDENCE_RPCS) {
      const pattern = new RegExp(`rpc\\(\\s*["']${rpc}["']`)
      if (pattern.test(content)) {
        const rel = file.replace(repoRoot + "/", "")
        assert.ok(
          allowlist.includes(rel),
          `${rel} calls evidence RPC ${rpc}; only lib/storage/evidence.ts may do so`,
        )
      }
    }
  }
})

test("migration 008 revokes service_role DML on every append-only table", () => {
  const migrationPath = join(repoRoot, "scripts/008_revoke_service_role_dml.sql")
  const sql = readFileSync(migrationPath, "utf8").toLowerCase()

  const appendOnlyTables = [
    "observations",
    "observation_revisions",
    "engagement_snapshots",
    "ingestion_artifacts",
    "sentiment_scores",
    "category_assignments",
    "impact_scores",
    "competitor_mentions",
    "classifications",
    "classification_reviews",
  ]

  // Collapse whitespace so multi-line REVOKE lists match regardless of
  // formatting.
  const collapsed = sql.replace(/\s+/g, " ")

  for (const t of appendOnlyTables) {
    assert.ok(
      collapsed.includes(t),
      `008 migration must reference ${t}`,
    )
  }

  // Each of INSERT / UPDATE / DELETE must appear in a REVOKE clause.
  assert.match(collapsed, /revoke[^;]*\binsert\b[^;]*from service_role/, "REVOKE INSERT missing")
  assert.match(collapsed, /revoke[^;]*\bupdate\b[^;]*from service_role/, "REVOKE UPDATE missing")
  assert.match(collapsed, /revoke[^;]*\bdelete\b[^;]*from service_role/, "REVOKE DELETE missing")
})
