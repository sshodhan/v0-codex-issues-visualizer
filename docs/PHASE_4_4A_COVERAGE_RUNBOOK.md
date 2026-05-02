# Phase 4 4a Coverage Push — Operator Runbook

**Goal:** push Stage 4a (LLM classification) coverage from the
2026-05-01 baseline of **16%** (78 / 487 active observations) to
**≥ 80%** before triggering the Phase 4 PR3 backfill UI.

**Why:** v3 embedding quality is bounded by 4a coverage. The Phase 4
helper gates on `canUseTaxonomySignals` (confidence ≥ medium AND not
review-flagged) — observations missing a classification fall through
the gate and emit only Tier 1 minus LLM taxonomy. With 16% coverage,
84% of v3 embeddings would be functionally a small upgrade over v2.
The Phase 5 dry-run measures the singleton/coherent/mixed deltas
against this coverage; a low coverage understates v3's true win and
risks a false-negative decision at the Phase 6 gate.

**When:** any time after PR #199 (Phase 4 PR2) is reviewed. Can run
in parallel with PR2 review/merge — the operational push doesn't
write to `observation_embeddings`, so PR2's wiring is untouched.

**Hard prerequisite for Phase 4 PR3:** completion of this runbook is
locked into the Phase 4 exit criteria (see
`docs/CLASSIFICATION_EVOLUTION_PLAN.md` Phase 4 §"Stage 4a / Stage 2
sequencing model"). PR3 MUST NOT trigger v3 backfill until this
runbook completes successfully.

---

## Pre-flight checks

### 1. Confirm starting coverage

Run against production via the Supabase SQL editor:

```sql
-- Active observations with vs. without a classification.
select
  count(*) filter (where exists (
    select 1 from classifications c where c.observation_id = o.id
  )) as classified,
  count(*) filter (where not exists (
    select 1 from classifications c where c.observation_id = o.id
  )) as unclassified,
  count(*) as total
from observations o
where exists (
  select 1 from cluster_members cm
   where cm.observation_id = o.id
     and cm.detached_at is null
);
```

Record the numbers. If `classified / total >= 0.80` already, **skip
this runbook** — coverage is already sufficient. Update the relevant
todo / Phase 4 status accordingly.

### 2. Confirm OpenAI quota / billing

The push will queue ~400 classifications. At gpt-5-mini pricing
(~$0.005 per call as of 2026-05), full corpus push ≈ **$2 total**.
Confirm:

- `OPENAI_API_KEY` is set on Vercel production.
- Account billing is current (no failed invoice).
- No rate-limit warnings in OpenAI dashboard for the past 24h.

### 3. Confirm classification queue isn't already saturated

Check the existing dashboard banner (top of `/`) for an "N awaiting
classification" indicator. If the daily cron has been running and
the queue is non-trivial (> 50 items), evaluate whether to wait for
the cron to drain naturally vs. forcing the manual push. The
runbook below assumes a manual push for speed; the cron-only path
takes ~30 days (cron caps at 10 obs/run).

---

## Push procedure

### Step 1 — open admin classification panel

Navigate to `/admin` in production. Enter the admin secret in the
page-level input. Locate the **Layer C Backfill** tab (alongside the
Layer 0 Backfill tab and the Layer A Clustering tab).

### Step 2 — preview the backlog

Click "Refresh stats" or equivalent. The panel shows:

- "N obs awaiting classification (in window)" — observations in the
  last 30 days that lack a classification.
- "N obs awaiting classification (all-time)" — full corpus backlog.
- An estimated cost per `?limit=N` batch.

For the Phase 4 prep push, we want **all-time** coverage, not just
the recent window. Switch the panel scope to all-time if there's a
toggle.

### Step 3 — run "Run until done" loop

Click **Run until done** (or **Backfill batch** + repeat). Each
batch runs `?limit=10` to `?limit=100` per call (route enforces
`MAX_LIMIT=100`). The orchestrator:

- Selects the N highest-impact unclassified observations (uses
  `MIN_IMPACT_SCORE` to skip low-signal noise).
- Calls Stage 4a per obs (gpt-5-mini → escalation to large model
  when small-model confidence < threshold).
- Writes a `classifications` row + `processing_events` row per obs.
- Returns batch stats.

Repeat until the panel reports "0 awaiting" or coverage hits ≥ 80%.

**Per-batch monitoring:**

| Watch | Action if seen |
|---|---|
| HTTP 504 / function timeout | Lower `?limit` (try 50 → 25 → 10) |
| OpenAI rate-limit error | Pause 60s, retry with same batch |
| Failed batches in stats > 5% | Stop the loop, investigate per-obs errors in `/admin → Cross-layer Trace` for a few sample IDs |
| Cost projection > $5 | Re-evaluate; the corpus is bigger than expected. Decide whether to continue or partial-push. |

### Step 4 — verify coverage hits target

Re-run the SQL from §1. Confirm `classified / total ≥ 0.80`. If
not, return to Step 3 and continue the push.

### Step 5 — sanity-check 20 random new classifications

Random spot-check to confirm the LLM output is reasonable (catches
the "model is hallucinating wildly" failure mode):

```sql
-- Random 20 freshly-written classifications.
select observation_id, category, subcategory, severity, confidence,
       reproducibility, impact, tags, created_at
from classifications
where created_at >= now() - interval '4 hours'
order by random()
limit 20;
```

For each row, eyeball:

- `category` is one of the documented Topic taxonomy slugs (e.g.,
  `bugs`, `usability`, `performance`, etc.) — not free-form
  hallucinated text.
- `subcategory` is consistent with the category (no `category=bugs
  subcategory=2fa-failure` mismatches).
- `confidence` is reasonable: most should be ≥ 0.50; ≥ 80% high
  confidence is healthy; > 30% in low confidence is a warning.
- `tags` array is non-empty for at least 80% of rows; tags are
  short snake_case-style strings, not full sentences.
- `reproducibility` and `impact` are populated (per Gap 2 from
  PR #194, these are now joined in the Phase 2 metric).

If > 3 of the 20 look broken, **stop**. File a bug, do NOT proceed
to PR3. The classification prompt may need tuning before v3
embedding generation runs against this output.

### Step 6 — record the post-push coverage

Append a row to a coverage history table (or just commit a note in
the plan doc). Format:

```
Date         Coverage  Classifications  Active obs  Notes
2026-05-01   16.0%     78               487         Phase 3 baseline
2026-05-XX   ##.#%     ###              ###         Pre-PR3 push
```

This becomes the "we pushed coverage before generating v3 rows"
breadcrumb when reading the plan doc later.

---

## Rollback

The Stage 4a push writes to `classifications` (append-only) and
`processing_events` (append-only). There is no rollback path other
than schema-level deletes, which would corrupt the audit trail.

**If the push needs to be paused:** simply stop calling the admin
endpoint. Existing classifications stay; the queue stops draining.
The daily cron continues to drain at 10 obs/run.

**If the push produces obviously-wrong classifications at scale:**
- Mark them `review_flagged=true` via the reviewer surface (PR3 +
  Phase 8 will streamline this; today it's per-row).
- Wait for Phase 7 (family validator) to provide a coherence check
  before regenerating v3 embeddings.
- Phase 4 PR2's stale-marker logic ensures bad classifications that
  later get review-flagged trigger fresh embeddings on next
  rebuild.

---

## Decision gate (this runbook → Phase 4 PR3)

PR3 MAY proceed when ALL of the following are true:

1. `classified / total ≥ 0.80` (confirmed via Step 1 SQL)
2. Random-sample spot-check (Step 5) shows ≤ 3 / 20 visibly broken
   classifications
3. No outstanding rate-limit / quota issues with OpenAI
4. Coverage history row recorded in the plan doc (Step 6)

When all four are true, **proceed to PR3**.

If any are false, **do not start PR3** until they are. PR3's
`?dry_run=true` mode is designed to be safe even at low coverage,
but its `?dry_run=false` apply mode will spend OpenAI quota
generating v3 embeddings whose quality is bounded by the gate that
4a coverage drives. Spending without pushing coverage first is
wasted budget.

---

## Cost summary

| Stage | Per-obs cost | Corpus cost (~487 obs) |
|---|---|---|
| Stage 4a push (this runbook) | ~$0.005 (gpt-5-mini) | ~$2 |
| Phase 4 PR3 v3 backfill | ~$0.001 (text-embedding-3-small) | ~$0.50 |
| **Combined Phase 4 cost** | | **~$2.50** |

The 4a push is the more expensive of the two. Worth confirming
billing before kicking it off.

---

## References

- `docs/CLASSIFICATION_EVOLUTION_PLAN.md` Phase 4 §"Stage 4a / Stage
  2 sequencing model" — convergence model spec.
- `app/api/admin/classify-backfill/route.ts` — admin classification
  backfill endpoint (this runbook drives it).
- `lib/classification/run-backfill.ts` — orchestrator behind the
  admin endpoint.
- `app/api/cron/classify-backfill/route.ts` — daily cron path
  (alternative slow-drain mechanism).
- PR #199 (Phase 4 PR2) — the production wiring that consumes
  4a output to build v3 embeddings.
