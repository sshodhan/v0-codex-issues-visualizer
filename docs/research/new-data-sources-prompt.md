# Research Prompt — New Data Sources & High-Value Signals

Hand this prompt to a fresh Claude Code session (or similar research agent) at the
repo root. It is self-contained: the agent does not need prior conversation
context, but it should read the files referenced below before proposing
anything.

---

## Your task

This repo (`v0-codex-issues-visualizer`) ingests public feedback about
**OpenAI Codex** and adjacent coding agents (GitHub Copilot, Cursor, etc.) from
six sources, derives sentiment / impact / urgency / category / fingerprint /
cluster signals, and surfaces them in a Next.js + Supabase dashboard with an
LLM-assisted triage layer.

**I want you to research NEW data sources we should ingest, and NEW
high-value signals we could compute, that would meaningfully improve the
product.** Output a ranked, actionable proposal — not a brainstorm dump.

You are doing research, not implementation. Do **not** write code or migrations.
Produce a single Markdown report at
`docs/research/new-data-sources-findings.md`.

---

## Step 1 — Ground yourself in what already exists (mandatory)

Before proposing anything, read these so you don't suggest things we already
have:

- `README.md`, `reflection.md`
- `docs/ARCHITECTURE.md`, `docs/SCORING.md`,
  `docs/CODEX_ISSUE_CLASSIFICATION_OPENAI.md`,
  `docs/ERROR_TRACKING_SYSTEM.md`, `docs/CLUSTERING_DESIGN.md`
- `lib/scrapers/providers/` — every current provider (github, github-discussions,
  reddit, hackernews, stackoverflow, openai-community)
- `lib/scrapers/shared.ts` and `lib/scrapers/bug-fingerprint.ts`
- `lib/analytics/realtime.ts`, `lib/analytics/competitive.ts`,
  `lib/analytics/sentiment-lexicon.ts`
- `lib/classification/pipeline.ts`
- `vercel.json` (cron cadence)
- `scripts/` (most recent 5 SQL migrations to understand the data model)

### Snapshot of what we already ingest (do not re-propose these)

| Source | Repos / scope |
|---|---|
| GitHub Issues (REST) | `openai/codex`, `openai/openai-cookbook`, `microsoft/vscode-copilot-release`, `github/copilot-docs`, `microsoft/vscode` |
| GitHub Discussions (GraphQL) | same orgs |
| Reddit | r/OpenAI, r/MachineLearning, r/programming, r/learnprogramming, r/ChatGPTCoding, r/ArtificialInteligence |
| Hacker News | Algolia search |
| Stack Overflow | tags `openai-api`, `github-copilot`, `openai-codex` |
| OpenAI Community (Discourse) | search.json |

### Signals already computed (do not re-propose these)

Sentiment (lexicon), impact score, urgency score (72h decayed volume + momentum
+ diversity), category assignment, bug fingerprint (error_code, stack_frame,
cli_version, os, shell, editor, model_id), compound cluster key, semantic
cluster (title-hash), competitor mention sentiment, LLM classification
(category/severity/why_surfaced/suggested_fix), 6h surge delta, daily trend.

### Known gaps in CURRENT sources (low-effort wins, not "new sources")

These are already-fetched fields not yet surfaced. **List them in your report
as Tier-0 quick wins, but they are not the main deliverable.**

- GitHub `reactions.total_count` — fetched, never displayed beyond impact score
- Stack Overflow `view_count` and `is_answered` — scraped, unused
- Author reputation / credibility — author stored, never weighted
- Time-of-day / day-of-week cyclicity — snapshots exist, never aggregated
- HN points momentum — folded into impact, never surfaced standalone
- GitHub Discussions accepted-answer flag — not tracked
- Per-source competitor mention breakdown — aggregated only

---

## Step 2 — Research new sources

Cast a wide net, then prune. Consider at minimum:

**Code & dev-platform telemetry**
- npm / PyPI download counts and version-adoption curves for `@openai/codex*`,
  `openai`, copilot-related packages
- VS Code / JetBrains marketplace: install counts, ratings, review text,
  version history for Copilot, Codex, Cursor, Cline, Continue, etc.
- GitHub repo signals beyond issues: star velocity, fork churn, dependents,
  release cadence, commit activity, code-search hits for known error strings
- GitHub code-search / Sourcegraph for in-the-wild error strings, retry
  patterns, workaround comments (`// codex bug:` etc.)

**Status & incident feeds**
- OpenAI status page RSS/JSON, GitHub status, Cursor / Anthropic / Copilot
  status feeds — correlate incidents with our issue spikes
- Public OpenAI / Copilot changelogs, release notes, model deprecation notices

**Social & community (beyond Reddit/HN)**
- X/Twitter (paid API tier or Nitter-style), Bluesky, Mastodon — keyword and
  handle tracking (@OpenAIDevs, @code, etc.)
- YouTube + transcripts — review/rant videos about Codex/Copilot
- LinkedIn posts (public), Dev.to, Hashnode, Medium tag feeds
- Discord servers (OpenAI, Cursor, etc.) — public channels only, ToS check
- Lobste.rs, Lemmy programming communities

**Q&A / support**
- Stack Exchange beyond the three current tags (DevOps, AI, SuperUser);
  related tags like `openai-completions-api`, `agentic-ai`, `mcp`
- Quora, Reddit beyond current subs (r/cursor, r/Codeium, r/LocalLLaMA,
  r/ExperiencedDevs)
- Microsoft Q&A, JetBrains support forums

**Search / trend signals**
- Google Trends for "codex error", "copilot broken", competitor terms
- Algolia DocSearch query logs (if any vendor exposes them)
- Wikipedia pageview API for Codex / Copilot articles (cheap zeitgeist proxy)

**Job market / commercial**
- Job postings mentioning Codex/Copilot (proxy for adoption)
- Pricing-page change tracking (visualping-style) for competitors

**Academic / structured**
- arXiv / Semantic Scholar for papers benchmarking these tools
- HuggingFace model/space activity for related models

For **each** candidate source, evaluate:
1. **Signal lift** — what specifically would it surface that current sources
   don't? Be concrete (e.g., "earliest detection of model regressions because
   status page leads issue spike by ~30 min").
2. **Access** — public API? auth? rate limits? cost? official ToS for scraping?
3. **Volume & noise** — typical items/day; signal-to-noise ratio; dedup risk
   with existing sources (HN often re-posts GH).
4. **Latency** — how fresh; can we fit our 6h cron or do we need faster?
5. **Stability** — is this a long-lived API or a fragile scrape target?
6. **Effort** — rough provider implementation cost (S/M/L) given our pattern
   in `lib/scrapers/providers/*.ts`.
7. **Legal/ethical** — PII, ToS, robots.txt, GDPR concerns.

---

## Step 3 — Research new signals

Independent of new sources, propose signals we could compute from data we
already have OR from your proposed new sources. Examples to consider (not
exhaustive — find more):

- **Author credibility weight** — repeat reporters, GitHub follower count,
  prior-issue-resolution rate
- **Reproducibility score** — presence of repro steps, minimal example, version
  info, log snippet (extend bug-fingerprint signals)
- **Resolution / lifecycle metrics** — time-to-first-response, time-to-close,
  reopen rate, "ghosted" rate
- **Cross-source amplification** — same fingerprint hitting 3+ sources within
  N hours = louder signal than single-source spike
- **Regression detection** — fingerprint absent for 30d then re-appears post-
  release = likely regression
- **Model/version cohort analysis** — issue rate per `model_id` / `cli_version`
- **Topic emergence** — TF-IDF or embedding-based novelty score for terms not
  seen in prior 30d
- **Competitive switching** — phrases like "switched from X to Y", "went back
  to Y", with directionality
- **Severity escalation** — sentiment trajectory within a single thread (gets
  angrier over time)
- **User intent classification** — bug vs. confusion vs. feature-ask vs. praise
  (we have category, but intent is finer)
- **Geographic / language signal** — non-English issue rate as adoption proxy

For **each** signal, specify:
- Inputs (which fields, from which sources — current or proposed)
- Computation sketch (1–3 sentences, no code)
- Where it would surface in the UI (which existing component or a new one)
- Why it's high-value — what decision does it enable that current signals don't?

---

## Step 4 — Deliverable

Write `docs/research/new-data-sources-findings.md` with this structure:

```
# Findings — New Data Sources & Signals

## TL;DR
- Top 3 new sources to ship next, one line each, with expected signal lift.
- Top 3 new signals to compute, one line each.

## Tier-0 Quick Wins (already-fetched, not yet surfaced)
Bullet list of the gaps section above, each with effort estimate and UI
landing spot.

## New Sources — Ranked
For each (ordered by value/effort ratio):
### N. <Source name>
- **What it adds**: <signal lift>
- **Access**: <API/auth/rate limits/cost>
- **Volume & noise**: <items/day, dedup risk>
- **Latency**: <freshness>
- **Stability**: <long-lived vs fragile>
- **Effort**: S | M | L — <reason>
- **Legal/ToS**: <flags>
- **Recommendation**: ship now / pilot / skip — <one-line reason>

## New Signals — Ranked
Same per-item structure: inputs, computation sketch, UI surface,
decision enabled, effort.

## Sources we considered and rejected
Brief table: source, why rejected (cost, ToS, low lift, dup with existing).

## Open questions for the team
Anything that needs a human call (legal, budget, scope).
```

---

## Constraints & style

- **Be specific**: "Twitter API v2 Basic tier, $200/mo, 10k tweets/mo, search
  endpoint, 15-min latency" — not "we could add Twitter".
- **Cite URLs** for any pricing, rate limits, or ToS claims you make.
- **No code, no SQL, no provider stubs** — research output only.
- **Rank ruthlessly.** If a source is interesting but low-lift-vs-noise, put
  it in "rejected" with reasoning. A short, opinionated list beats a long
  neutral one.
- **Respect existing scope**: this product is about Codex + adjacent coding
  agents, not general dev sentiment. Sources that don't bear on that should
  be rejected or scoped narrowly.
- **Cap the report at ~2,500 words.** Tables are fine.
- **Do not modify any other files.** Only write the findings doc.
