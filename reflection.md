# PR+1 reflection — what the fingerprint-actionable PR deferred

_Generated on `claude/actionable-bug-cluster-signal-DvCtL` (branch #NN after PR #51), 2026-04-22. Every deferred item is tagged `// TODO(PR+1): see reflection.md` in the code where it lives so the next engineer finds this file via grep._

The fingerprint-actionable PR made the bug-cluster signal **observable + actionable**. It did not make it **collaborative**. An analyst can now:

- see which error fingerprints spiked in the last 24 h,
- drill into the exact observations behind any error chip,
- trust the priority matrix to rank code-addressable clusters over unsourced complaints,
- read an LLM classification that received structured env + repro context.

What the analyst still **can't** do:

1. See an LLM synthesis across a whole cluster (only per-observation classifications).
2. Claim ownership of a cluster — no assignee, status, or linked issue tracker URL.
3. Compare two clusters side-by-side to decide whether they're duplicates.
4. Tell at a glance that an LLM classification is stale and worth refreshing.
5. Rely on automation to keep classifications fresh for the long tail — only newly-ingested observations get classified today.

The five deferred items below address those gaps. They are **independent** — each is shippable on its own — but the numbered ordering below is the suggested sequence because each one raises the next one's value. Estimates assume one engineer, no unknown unknowns.

---

## 1. Cluster-level LLM synthesis (~2–3 days)

**Problem.** Every observation has its own `classifications` row. Analysts reading a cluster of 18 observations have 18 mini-summaries and no single "here's what this cluster is actually about" paragraph. The LLM ceiling for actionable copy is at cluster granularity, not per-observation.

**Shape.**
- New derivation kind `cluster_synthesis` (migration 015). Row shape: `(cluster_id, algorithm_version, summary text, representative_observations uuid[], severity text, suggested_fix text, confidence numeric, raw_json jsonb, computed_at)`. Stamped with the classifier model/version.
- New `/api/clusters/:id/synthesize` route. GET returns the most recent synthesis; POST forces a fresh pass. Input payload builds from the cluster's canonical observation title + body, plus the top-N (by impact) member titles/bodies, plus the fingerprint roll-up the priority matrix already computes.
- Reuses `classifyReport`'s retry/validation machinery — extract the model-call shell into `runStructuredClassifier(prompt, schema, options)` and share it.
- SignalLayers panel gets a third layer: **Regex → LLM (per observation) → Synthesis (per cluster)**.

**Watch-outs.**
- Re-using `classifications` for cluster rows mixes granularity. A distinct table is cleaner — 015 should create it rather than overload.
- The synthesis prompt needs the same evidence-quotes guard as `classifyReport`; arbitrary summaries are the classic hallucination surface.
- Cost: at ~100 active clusters and a gpt-5 pass each, one synthesis run is ~$0.50. Rate-limit (one synthesis per cluster per 24h unless forced).

**Trigger for PR+2.** Once synthesis exists, the "cluster card" UI becomes worth building (currently the dashboard has no cluster-first surface — every surface is observation-first with a cluster roll-up).

---

## 2. Cluster workflow state / assignee / linked_issue_url (~1 day)

**Problem.** Analysts have no way to say "I'm working on ENOENT-on-startup" or "this maps to github.com/openai/codex/issues/1234". Triage today is verbal; the dashboard is read-only.

**Shape.**
- New table `cluster_workflow (cluster_id pk, status text check in ('new','triaged','in-progress','blocked','resolved'), assignee text, linked_issue_url text, updated_at, updated_by)`.
- `PATCH /api/clusters/:id/workflow` — validates enum, writes via a SECURITY DEFINER RPC (keeps the RLS invariant from §5.6).
- `mv_observation_current` gets three new columns from a `left join cluster_workflow`. Priority-matrix tooltip and surge card show status + assignee.
- Filter bar on the issues table gains `workflow_status` and `assignee` filters.

**Watch-outs.**
- Workflow rows should be UPSERT-able (one row per cluster) — they're *state*, not *evidence*. Diverge from the three-layer append-only rule deliberately and document it in ARCHITECTURE.md §5.8.
- `assignee` is free-text (no auth); if the repo grows an auth surface later, swap to a user_id FK.
- A `linked_issue_url` regex/allowlist check prevents obvious junk (github.com, gitlab.com, linear.app). Do NOT validate that the URL resolves — 403s on private issues should still be linkable.

---

## 3. Pairwise cluster diff view (~1–2 days)

**Problem.** Sibling clusters are common (same category, similar titles, different root causes). Analysts want to decide "merge" or "keep separate" without flipping between two issues-table filters.

**Shape.**
- `/api/clusters/diff?left=<id>&right=<id>` returns side-by-side metrics: observation counts, avg impact, top error codes, top subcategories, sentiment mix, representative titles, source distribution.
- New `ClusterDiff` dashboard card, launched from a cluster card's "Compare" button (requires #2 to land the card first, but can ship independently behind a URL-param launcher).
- Purely read-time — no new table, no schema change.

**Watch-outs.**
- `v_cluster_source_diversity` already shows how to aggregate off mv_observation_current for a cluster. Reuse that pattern — don't add another view.
- Diff explanations ("these clusters differ on `cli_version`: left is 1.2.x, right is 1.3.x") become trivial once #1 ships — the synthesis row already captures the dominant env tokens. Without #1, the diff view is mechanical; with #1, it's explanatory.

---

## 4. LLM-classification staleness indicator (~0.5 day)

**Problem.** A `classifications` row written in February against gpt-5-mini with no env context is still the "latest" for an observation today. SignalLayers shows it without any hint that the fingerprint now provides env data the classification never saw.

**Shape.**
- No schema change. `mv_observation_current` already carries `llm_classified_at`.
- SignalLayers compares `llm_classified_at` vs `bug_fingerprints.computed_at` and shows a "stale" badge when the fingerprint post-dates the classification by >24h AND the classification was written without env (check `classifications.raw_json -> 'env'`).
- Optional: a "Refresh" button on the stale badge that calls `POST /api/observations/:id/classify`.

**Watch-outs.**
- Don't gate "stale" on model version alone — model drift can happen mid-week and invalidates half the corpus overnight. The env/fingerprint post-date check is the narrower, correct signal for the specific drift the fingerprint-actionable PR introduced.

---

## 5. Nightly "classify oldest unclassified high-impact" loop (~0.5 day)

**Problem.** The scraper only classifies **new** observations. The long tail (observations ingested before PR #NN landed, or observations whose ingest-time classification failed) never gets a retry. Right now "unclassified high-impact rows" silently accrete.

**Shape.**
- New Vercel cron route `/api/cron/classify-backfill` (daily at 03:00 UTC — after the main scrape cron).
- Query: `mv_observation_current` where `llm_classification_id IS NULL` and `impact_score >= 6`, sorted by `impact_score DESC, published_at DESC`, limited to ~25 per run (budget: ~$1/run).
- Reuses `processObservationClassificationQueue` with `reclassifyExisting: false` — the dedupe guard is already correct.
- Logs summary to `scrape_logs` with `source_id = null, status = 'completed', issues_found = <candidates>, issues_added = <classified>` so the existing dashboard "Last sync" chip picks it up.

**Watch-outs.**
- The "ingested 6 months ago" case pulls observations from before migration 013 landed — their `bug_fingerprints` rows may not exist. The backfill script `scripts/013_backfill_fingerprints.ts` should run **first** so this loop has env/repro to thread through.
- Rate-limit check: at 25 observations/day, clearing a 10k-row backlog takes 400 days. If the backlog is large, either increase the cap (costs scale linearly) or add a one-shot admin backfill route parallel to `/api/admin/backfill-derivations`.

---

## Dependency graph

```
#2 cluster workflow ──────────┐
                              │
#1 cluster synthesis ─┬──► #3 pairwise diff (more useful after #1)
                      │
                      └──► #4 staleness indicator (mechanical without #1, diagnostic with it)

#5 classify-backfill (independent; depends only on 013's fingerprint backfill having run)
```

## Recommended sequence

1. **#5 first** (half-day) — it fills the existing gap invisibly and unblocks #1's value proposition (cluster synthesis quality depends on per-observation classifications existing for the cluster's members).
2. **#2 + #4** (one-and-a-half days) — independent wins. #2 gets analysts claiming territory; #4 tells them which LLM rows to revisit.
3. **#1** (two-three days) — the big unlock. Plan for one week with review + rollout.
4. **#3** (one-two days) — best after #1 because the diff "why" surface is richer.

## Non-goals for PR+1

These came up in review and are explicitly **out of scope** until PR+2 or later:

- **Merging clusters** — #3 (diff) implies a "merge" button, but cluster merges touch `cluster_members` and `canonical_observation_id`, which has append-only semantics and detach/reattach RPCs that need deliberate design. Not a drive-by feature.
- **Per-observation email/Slack alerts on surges** — fingerprint_surges is read-time; push notifications need a scheduler + subscription model. The dashboard surge card covers the 95% case.
- **Multi-tenant ownership of clusters** — #2 keeps `assignee` as free text intentionally; per-org visibility is a different architecture conversation.
- **Backfilling cluster_synthesis to historical clusters** — #1 ships synthesis for forward-looking clusters; a one-shot historical backfill is a separate admin route.
