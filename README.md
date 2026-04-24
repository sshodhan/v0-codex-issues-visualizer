# Codex Issues Visualizer

If the codebase feels overwhelming, start here.

## 1) 90-second mental model

The app has **four big layers**:

1. **Ingest** feedback from public sources (`lib/scrapers/*`, `/api/scrape*`).
2. **Derive** signals (sentiment, category, impact, classification) (`lib/analytics/*`, `lib/classification/*`).
3. **Store/query** everything via Supabase-backed API routes (`app/api/*`, `lib/storage/*`).
4. **Present** dashboard + triage UI (`app/page.tsx`, `components/dashboard/*`).

When something looks wrong in UI, debug in reverse:
`component -> API route -> lib module -> DB function/view`.

## 2) Where to look first (by task)

- **"Why is this chart/table value wrong?"**
  - UI: `components/dashboard/*`
  - Data hooks: `hooks/use-dashboard-data.ts`
  - API payload shaping: `app/api/stats/route.ts`, `app/api/issues/route.ts`
  - Core calculations: `lib/analytics/*`

- **"Why didn't a new post show up?"**
  - Scrape triggers: `app/api/scrape/route.ts`, `app/api/cron/scrape/route.ts`
  - Source adapters: `lib/scrapers/providers/*`
  - Scrape orchestration: `lib/scrapers/index.ts`
  - Persistence: `lib/storage/evidence.ts`

- **"Why is AI triage empty/weird?"**
  - Queue + model flow: `lib/classification/pipeline.ts`
  - Backfill selection: `lib/classification/backfill-candidates.ts`
  - API reads/writes: `app/api/classifications*/route.ts`, `app/api/observations/[id]/classify/route.ts`
  - Triage UI: `components/dashboard/classification-triage.tsx`

- **"Where do schema/table assumptions live?"**
  - SQL migrations/functions: `scripts/*.sql`
  - Long-form schema docs: `docs/ARCHITECTURE.md`, `docs/CLUSTERING_DESIGN.md`

## 3) Simplified request flow

```text
Dashboard (React)
  -> hooks/use-dashboard-data.ts
  -> app/api/*.ts routes
  -> lib/* domain modules
  -> Supabase/Postgres (tables, views, RPC)
```

```text
Scrape cron/manual
  -> app/api/cron/scrape or app/api/scrape
  -> lib/scrapers/index.ts + providers
  -> evidence + derivation writes
  -> dashboard/API reads from materialized views
```

## 4) Fast local commands

- `npm run dev` — run UI + API locally
- `npm test` — run unit/integration test suite
- `npm run lint` — static checks

## 5) If you only read one deeper doc

Read `docs/ARCHITECTURE.md` for the complete data model and end-to-end flows.
