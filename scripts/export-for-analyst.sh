#!/usr/bin/env bash
# scripts/export-for-analyst.sh
#
# Read-only export of the `public` schema (DDL + data) for handoff to a
# data analyst. Produces three parallel views of the same DB so the
# analyst can pick whichever fits their toolchain:
#
#   1. schema.sql          - portable DDL (tables, indexes, FKs, RLS,
#                            functions, materialized views). Loadable
#                            into any Postgres via `psql -f schema.sql`.
#   2. data.dump           - pg_dump custom format (compressed, parallel-
#                            restorable). Loadable via `pg_restore`.
#   3. csv/<table>.csv     - one CSV per public-schema table for pandas
#                            / DuckDB / Excel / sqlite.
#
# Plus:
#   - summary.json   - row counts per table, snapshot timestamp,
#                      Postgres version, schema-verifier RPC output if
#                      migration 015 has been applied.
#   - README.md      - regenerated each run; explains what's in the dir.
#
# Output lands in `exports/<UTC-timestamp>/`. The `exports/` directory
# is added to .gitignore so accidental dumps never get committed.
#
# ----------------------------------------------------------------------
# Requirements
# ----------------------------------------------------------------------
#   - postgresql-client installed (provides `psql`, `pg_dump`).
#       Linux:   apt-get install postgresql-client
#       macOS:   brew install postgresql@16  (or any 14+; matches Supabase)
#   - DATABASE_URL env var set to the Supabase project's connection
#     string. Find it in Supabase project settings -> Database ->
#     Connection string -> URI. Use the *direct* (5432) URL, not the
#     pooler (6543) — pg_dump opens long-lived sessions that the pooler
#     terminates.
#
# Optional env vars:
#   SKIP_CSV=1            skip per-table CSV export (saves time on
#                         large dumps, e.g. ingestion_artifacts).
#   SKIP_DUMP=1           skip pg_dump custom format (only emit
#                         schema.sql + CSVs).
#   INCLUDE_TABLES=a,b    only export named tables (default: all in
#                         public schema). Useful for quick previews.
#   EXCLUDE_TABLES=a,b    skip named tables. Default excludes none, but
#                         consider `ingestion_artifacts` if the raw
#                         scrape payloads contain content you don't
#                         want sent to a third party.
#
# ----------------------------------------------------------------------
# Usage
# ----------------------------------------------------------------------
#   export DATABASE_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'
#   ./scripts/export-for-analyst.sh
#
#   # Minimal preview without raw payloads or compressed dump:
#   SKIP_DUMP=1 EXCLUDE_TABLES=ingestion_artifacts \
#     ./scripts/export-for-analyst.sh
#
# Idempotent and side-effect-free against the source DB. Each run writes
# to a fresh `exports/<timestamp>/` directory; nothing is overwritten.
#
# ----------------------------------------------------------------------

set -euo pipefail

# --- preflight ---------------------------------------------------------

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is not set." >&2
  echo "       Set it to the Supabase direct (port 5432) connection string." >&2
  echo "       Project settings -> Database -> Connection string -> URI." >&2
  exit 2
fi

for bin in psql pg_dump; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: $bin not found. Install postgresql-client and retry." >&2
    exit 2
  fi
done

# Quick connectivity probe before we set up the output dir, so a
# bad URL fails fast rather than after creating empty directories.
if ! psql "$DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1; then
  echo "error: cannot connect with DATABASE_URL." >&2
  echo "       Sanity-check by running:  psql \"\$DATABASE_URL\" -c 'select 1'" >&2
  exit 2
fi

# --- output dir --------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$REPO_ROOT/exports/$TIMESTAMP"
mkdir -p "$OUT_DIR/csv"

echo "==> Exporting to $OUT_DIR"

# --- table list --------------------------------------------------------

# Resolve which tables to export. Comma-separated env vars are normalized
# to whitespace-separated lists for the bash loops below.
read_csv_var() {
  # shellcheck disable=SC2086
  echo "${1:-}" | tr ',' ' ' | xargs -n1 echo | grep -v '^$' || true
}

INCLUDE_LIST="$(read_csv_var "${INCLUDE_TABLES:-}")"
EXCLUDE_LIST="$(read_csv_var "${EXCLUDE_TABLES:-}")"

if [[ -n "$INCLUDE_LIST" ]]; then
  TABLES="$INCLUDE_LIST"
else
  TABLES="$(psql "$DATABASE_URL" -tAc "
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  ")"
fi

# Filter excludes.
if [[ -n "$EXCLUDE_LIST" ]]; then
  for excl in $EXCLUDE_LIST; do
    TABLES="$(echo "$TABLES" | grep -vx "$excl" || true)"
  done
fi

if [[ -z "$TABLES" ]]; then
  echo "error: no tables matched after include/exclude filters." >&2
  exit 2
fi

echo "==> Tables: $(echo $TABLES | tr '\n' ' ')"

# --- 1. schema.sql -----------------------------------------------------

echo "==> Dumping DDL -> schema.sql"
pg_dump "$DATABASE_URL" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  --file="$OUT_DIR/schema.sql"

# --- 2. data.dump (custom format) -------------------------------------

if [[ "${SKIP_DUMP:-0}" != "1" ]]; then
  echo "==> Dumping data -> data.dump (custom format)"
  PG_DUMP_TABLE_ARGS=()
  for t in $TABLES; do
    PG_DUMP_TABLE_ARGS+=("--table=public.$t")
  done
  pg_dump "$DATABASE_URL" \
    --data-only \
    --no-owner \
    --no-privileges \
    --format=custom \
    --compress=9 \
    "${PG_DUMP_TABLE_ARGS[@]}" \
    --file="$OUT_DIR/data.dump"
else
  echo "==> SKIP_DUMP=1 set, skipping pg_dump custom format"
fi

# --- 3. csv/<table>.csv ------------------------------------------------

if [[ "${SKIP_CSV:-0}" != "1" ]]; then
  echo "==> Exporting per-table CSVs -> csv/"
  for t in $TABLES; do
    out="$OUT_DIR/csv/$t.csv"
    # \copy is client-side, so it works regardless of the server's
    # role/grant matrix and writes to a path the script controls.
    # FORCE_QUOTE * keeps JSONB and array columns intact across the
    # round trip into pandas / DuckDB.
    psql "$DATABASE_URL" \
      --quiet \
      --no-psqlrc \
      -c "\copy (select * from public.\"$t\") to '$out' with (format csv, header true, force_quote *)"
    bytes="$(wc -c <"$out" | tr -d ' ')"
    echo "    $t  ($bytes bytes)"
  done
else
  echo "==> SKIP_CSV=1 set, skipping per-table CSV export"
fi

# --- 4. summary.json ---------------------------------------------------

echo "==> Writing summary.json"

PG_VERSION="$(psql "$DATABASE_URL" -tAc 'select version()')"

# Build row counts one query per table. Postgres can't substitute table
# names in plain SQL parameters, so a single-round-trip COUNT-all is
# off the table; this loop is fine for the scale we expect (<30 tables).
ROW_COUNTS_TMP="$OUT_DIR/.row_counts.tmp"
: >"$ROW_COUNTS_TMP"
for t in $TABLES; do
  cnt="$(psql "$DATABASE_URL" -tAc "select count(*) from public.\"$t\"" 2>/dev/null || echo "null")"
  printf '  "%s": %s,\n' "$t" "$cnt" >>"$ROW_COUNTS_TMP"
done
# Strip the trailing comma off the last line so the JSON is valid.
sed -i.bak '$ s/,$//' "$ROW_COUNTS_TMP" 2>/dev/null || sed -i '' '$ s/,$//' "$ROW_COUNTS_TMP"
rm -f "$ROW_COUNTS_TMP.bak"

# If migration 015 (schema verifier) is applied, embed its snapshot too
# so the analyst gets a structured manifest of every public-schema
# object alongside the data.
SCHEMA_SNAPSHOT="$(psql "$DATABASE_URL" -tAc 'select get_schema_snapshot()' 2>/dev/null || echo '')"
if [[ -z "$SCHEMA_SNAPSHOT" ]]; then
  SCHEMA_SNAPSHOT='null'
fi

cat >"$OUT_DIR/summary.json" <<EOF
{
  "snapshot_at": "$TIMESTAMP",
  "postgres_version": $(printf '%s' "$PG_VERSION" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || printf '%s' "\"$PG_VERSION\""),
  "tables_exported": [$(echo "$TABLES" | awk '{printf "%s\"%s\"", (NR>1?",":""), $0}')],
  "row_counts": {
$(cat "$ROW_COUNTS_TMP")
  },
  "schema_snapshot": $SCHEMA_SNAPSHOT
}
EOF
rm -f "$ROW_COUNTS_TMP"

# --- 5. README.md ------------------------------------------------------

cat >"$OUT_DIR/README.md" <<'README'
# Export bundle

Read-only snapshot of the `public` schema, produced by
`scripts/export-for-analyst.sh`.

## Files

| File              | What it is                                              | How to use it |
| ----------------- | ------------------------------------------------------- | ------------- |
| `schema.sql`      | DDL only — tables, indexes, FKs, RLS, functions, MVs    | `psql NEWDB -f schema.sql` |
| `data.dump`       | Compressed `pg_dump --format=custom` of all rows        | `pg_restore -d NEWDB --no-owner data.dump` |
| `csv/*.csv`       | One CSV per table; `force_quote *` so JSONB/arrays survive | pandas / DuckDB / Excel |
| `summary.json`    | Row counts, Postgres version, snapshot timestamp, full schema snapshot (if migration 015 applied) | Human / programmatic audit |

## Restore on a fresh Postgres

```bash
createdb codex_analytics
psql codex_analytics -f schema.sql
pg_restore -d codex_analytics --no-owner --data-only data.dump
```

The two-step (schema first, then data) avoids ordering hazards with
materialized views and functions that the data-only restore depends on.

## Quick analysis without restoring

```bash
# DuckDB can read CSVs directly with no setup:
duckdb -c "select count(*) from read_csv('csv/observations.csv')"

# Or load into pandas:
python3 -c "import pandas as pd; print(pd.read_csv('csv/observations.csv').head())"
```

## Caveats

- **Materialized views**: `schema.sql` includes their definitions; their
  data is NOT in `data.dump` (pg_dump skips MV contents). After restore,
  run `select refresh_materialized_views()` to populate them.
- **`pg_trgm` extension**: required by some indexes. The schema.sql
  emits `CREATE EXTENSION` for it, but the target Postgres role must
  have permission to create extensions, or pre-create it manually.
- **RLS**: policies are restored, but they reference the Supabase
  `anon` / `authenticated` / `service_role` roles. On a non-Supabase
  target, either create those roles or run with a superuser that
  bypasses RLS.
- **`ingestion_artifacts.payload`**: contains the raw scrape JSON,
  including author handles and URLs from the upstream sources. If
  that's sensitive for your handoff, re-run the export with
  `EXCLUDE_TABLES=ingestion_artifacts`.
README

# --- done -------------------------------------------------------------

echo
echo "==> Done. Bundle:"
( cd "$OUT_DIR" && du -sh . && find . -maxdepth 2 -type f | sort )
