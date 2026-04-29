-- 033_classification_jobs.sql
--
-- Async job queue for Stage 4 classification work (per-observation LLM
-- classification AND cluster family naming/interpretation). Lets the
-- admin panel enqueue a "run N items in the background" request that
-- returns immediately with a job_id; subsequent batches are processed
-- by the /api/cron/classification-jobs tick (every 2 min on the Pro
-- plan; see vercel.json) and opportunistically by the /:id/advance
-- endpoint while the operator's browser is open.
--
-- The synchronous /api/admin/classify-backfill and
-- /api/admin/family-classification endpoints continue to work unchanged
-- for power-users who want immediate feedback inside one request. This
-- table is purely additive — it never mutates `family_classifications`,
-- `observations_classified`, or any other Stage 1-4 product table. The
-- worker calls the same orchestrators those endpoints already use, so
-- the write path stays canonical.
--
-- See docs/ARCHITECTURE.md §6.0 for the 5-stage pipeline this Stage 4
-- queue feeds. PR #160 introduced the read-only quality dashboard, PR
-- #163 the QA review feedback loop; this migration is the third piece —
-- a way to actually run the classifier on a backlog without sitting on
-- the Vercel function timeout.

begin;

create table if not exists classification_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Which Stage 4 sub-product this job runs against. The worker picks
  -- the orchestrator based on this:
  --   'observation' → runClassifyBackfill (per-observation LLM)
  --   'cluster'     → classifyClusterFamily over a ranked list
  -- Adding a new kind requires extending the worker AND this CHECK.
  kind text not null
    check (kind in ('observation', 'cluster')),
  -- Lifecycle. queued → running → (completed | failed | cancelled).
  -- 'running' means the worker has claimed at least one batch; the
  -- claim is fenced by `heartbeat_at` so a crashed worker doesn't pin
  -- the job indefinitely (see worker reclaim logic).
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  -- Free-form parameters frozen at enqueue time. For 'observation':
  --   { limit, minImpactScore, refreshMvs }
  -- For 'cluster':
  --   { limit, clusterIds? }  // when clusterIds is set, work the
  --                           // explicit list instead of the top-N
  -- Frozen so a re-tick after operator changes the form still runs the
  -- ORIGINAL request, not the live form values.
  params jsonb not null default '{}'::jsonb,
  -- Total items the worker plans to process. Sometimes unknown at
  -- enqueue time (the candidate count is computed lazily on the first
  -- batch); nullable until then. Operator-facing progress falls back to
  -- "X processed" when total is null.
  total_target integer null,
  processed integer not null default 0,
  classified integer not null default 0,
  failed integer not null default 0,
  -- Compact rolling buffer of the last few failures so the operator can
  -- see what's going wrong without paging through logs. Bounded by the
  -- worker (writes only the most recent N entries).
  failures jsonb not null default '[]'::jsonb,
  last_error text null,
  -- Last claim heartbeat. The worker writes this every batch so a
  -- different cron tick can detect "running but stale" jobs and reclaim
  -- them. Independent of `updated_at` because some writes (cancel) MUST
  -- NOT extend the claim.
  heartbeat_at timestamptz null,
  -- Reverse pointer to the scrape_logs row the cron tick opened, so an
  -- audit trail "what cron run advanced this job?" survives.
  last_log_id uuid null,
  enqueued_by text null default 'admin',
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null,
  cancelled_at timestamptz null
);

-- Worker pickup index: drain queued jobs FIFO, plus a partial index for
-- "running but stale" reclaim. The two patterns differ enough that
-- separate partial indexes are clearer than a composite.
create index if not exists idx_classification_jobs_queued_created
  on classification_jobs (created_at)
  where status = 'queued';

create index if not exists idx_classification_jobs_running_heartbeat
  on classification_jobs (heartbeat_at)
  where status = 'running';

-- "Recent jobs" sidebar / status strip — sorts the last N by recency
-- regardless of status.
create index if not exists idx_classification_jobs_created_desc
  on classification_jobs (created_at desc);

-- Filter by kind for the per-panel active-job badge ("is there a
-- background observation job running right now?").
create index if not exists idx_classification_jobs_kind_status
  on classification_jobs (kind, status);

-- RLS: writes only via service_role (this is admin-secret-gated work,
-- never user-driven). Reads also restricted to service_role because the
-- failures buffer can leak observation IDs / titles. The admin panel
-- reaches the table via /api/admin/classification-jobs, which uses the
-- service-role client after passing requireAdminSecret.
alter table classification_jobs enable row level security;

drop policy if exists "service_rw_classification_jobs" on classification_jobs;

create policy "service_rw_classification_jobs"
  on classification_jobs for all to service_role using (true) with check (true);

commit;
