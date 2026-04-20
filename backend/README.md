# Codex Market Analysis — FastAPI backend

Serves the Codex crisis/market-analysis dataset to the Next.js frontend.

The dataset is authored in `app/seed_data.py` — **that module is the single
source of truth**. `scripts/003_seed_data.json` and
`../scripts/003_create_analysis_schema.sql` are generated from it.

## Run locally (no DB required)

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env           # both DATABASE_URL and REDIS_URL may stay blank
uvicorn app.main:app --reload  # http://localhost:8000
```

With blank env vars the API serves straight from `seed_data.py`, so every
endpoint returns the canonical Claude-provided numbers. `GET /health` will
show `"seed_fallback": true`.

Open `http://localhost:8000/docs` for interactive Swagger.

## Smoke checks

```bash
curl -s localhost:8000/health | jq
curl -s localhost:8000/api/v1/timeline | jq '{n: .points|length, trough: .peak_crisis, peak: .peak_recovery}'
curl -s localhost:8000/api/v1/root-causes | jq 'length'          # 9
curl -s localhost:8000/api/v1/user-segments | jq 'length'        # 5
curl -s localhost:8000/api/v1/analytics/competitive | jq 'length'# 4
curl -s 'localhost:8000/api/v1/issues?limit=3' | jq '.total'     # 16
curl -s 'localhost:8000/api/v1/issues/search?q=compaction' | jq 'length'
```

## Run tests

```bash
cd backend
python -m pytest -q
```

The suite runs purely against the seed-data fallback, so it doesn't need
Supabase. It asserts the exact values from the brief (e.g. Oct-2025
trough = 35, Apr-2026 recovery = 82, Enterprise 78/92, compact.rs = 12%).

## Connect to Supabase

1. Apply the schema in the Supabase SQL editor:
   `scripts/003_create_analysis_schema.sql` (generated from `seed_data.py`).
2. Fill `backend/.env`:
   - `DATABASE_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres`
   - (optional) `REDIS_URL=redis://localhost:6379/0`
3. Restart uvicorn. `/health` should now report `"db": "connected"` and
   `"seed_fallback": false`.

## Regenerate artifacts after editing `seed_data.py`

```bash
# from repo root
python -m backend.scripts.export_seed_json         # → scripts/003_seed_data.json
python -m backend.scripts.generate_sql_migration   # → scripts/003_create_analysis_schema.sql
```

## API surface

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | liveness + db/redis status |
| GET | `/api/v1/issues` | filters: `category`, `severity`, `sentiment_min`, `sentiment_max`, `segment`, `limit`, `offset` |
| GET | `/api/v1/issues/search?q=` | title + description substring |
| GET | `/api/v1/issues/{id}` | issue + category + root cause + related issues |
| GET | `/api/v1/timeline` | 16 monthly points + peak_crisis/peak_recovery convenience fields |
| GET | `/api/v1/root-causes` | 9 root causes with `affected_issue_count` |
| GET | `/api/v1/root-causes/{id}` | root cause + affected issues |
| GET | `/api/v1/user-segments` | 5 segments sorted by crisis severity |
| GET | `/api/v1/user-segments/{slug}/impact-analysis` | segment + affected issues + derived metrics |
| GET | `/api/v1/analytics/sentiment` | distribution + trend + stats |
| GET | `/api/v1/analytics/categories` | per-category counts + avg sentiment |
| GET | `/api/v1/analytics/competitive` | Codex/Claude Code/Copilot/Gemini scorecards |
