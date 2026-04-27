"use client"

import { ExternalLink, Terminal } from "lucide-react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const SCRIPT_PATH = "scripts/021_backfill_deterministic_labels.ts"
const REPO_URL =
  "https://github.com/sshodhan/v0-codex-issues-visualizer/blob/main/" +
  SCRIPT_PATH

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs font-mono leading-relaxed">
      <code>{children}</code>
    </pre>
  )
}

export function LabelBackfillRunbookPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Terminal className="h-4 w-4" />
            Cluster-label backfill runbook
          </CardTitle>
          <CardDescription>
            A one-shot script that walks every cluster, recomputes a
            deterministic label, and writes it back to{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              clusters.label
            </code>
            . Run it whenever the dashboard is showing raw issue titles
            instead of family names — that means the producer never
            wrote a label and the consumer is falling back.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Source:{" "}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
            >
              <code className="text-[12px]">{SCRIPT_PATH}</code>
              <ExternalLink className="h-3 w-3" />
            </a>
          </p>
          <p className="text-muted-foreground">
            The script uses the Supabase service-role key, so it must
            run from a trusted machine — not from the dashboard, not
            from a Vercel function. This page is documentation; it
            does not execute the script.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What it does</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Connects to Supabase as the service role and selects
              every cluster where{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                label IS NULL
              </code>
              ,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                label_confidence &lt; 0.6
              </code>
              , or{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                label_model = &apos;fallback:title&apos;
              </code>
              .
            </li>
            <li>
              For each candidate, pulls active members → their
              dominant topic slug → their dominant error code.
            </li>
            <li>
              Composes a deterministic label using the same{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                composeDeterministicLabel
              </code>{" "}
              ladder the live producer uses (Topic + ErrorCode &rarr;
              Topic &rarr; ErrorCode &rarr; Title).
            </li>
            <li>
              In dry-run mode, writes a JSON report to{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                scripts/tmp/cluster-label-backfill-YYYYMMDD.json
              </code>
              . In apply mode, persists labels via the{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                set_cluster_label
              </code>{" "}
              RPC.
            </li>
          </ol>
          <p className="pt-2 text-muted-foreground">
            Idempotent: re-running only re-touches rows still under
            0.6 confidence, so any high-confidence LLM labels written
            between runs are preserved.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where to run it</CardTitle>
          <CardDescription>
            Your laptop (or any trusted machine) with a clone of the
            repo, Node 22+, and Supabase service-role credentials.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <p className="mb-1 font-medium">1. Pull env vars from Vercel</p>
            <CodeBlock>{`# from the repo root, on your laptop
vercel env pull .env.local`}</CodeBlock>
            <p className="mt-1 text-xs text-muted-foreground">
              If the Vercel CLI isn&apos;t set up, copy{" "}
              <code className="text-[11px]">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
              and{" "}
              <code className="text-[11px]">SUPABASE_SERVICE_ROLE_KEY</code>{" "}
              from Vercel &rarr; Project Settings &rarr; Environment
              Variables into a local{" "}
              <code className="text-[11px]">.env.local</code>.
            </p>
          </div>

          <div>
            <p className="mb-1 font-medium">
              2. Dry run (no DB writes — safe to run any time)
            </p>
            <CodeBlock>{`node --env-file=.env.local --experimental-strip-types \\
  scripts/021_backfill_deterministic_labels.ts --dry-run`}</CodeBlock>
            <p className="mt-1 text-xs text-muted-foreground">
              Writes a JSON report to{" "}
              <code className="text-[11px]">scripts/tmp/</code>. Open
              it and check: the{" "}
              <code className="text-[11px]">by_model</code> tally,
              total{" "}
              <code className="text-[11px]">candidate_clusters</code>,
              and a sample of{" "}
              <code className="text-[11px]">new_label</code> values.
            </p>
          </div>

          <div>
            <p className="mb-1 font-medium">
              3. Apply for real (persists labels to Supabase)
            </p>
            <CodeBlock>{`CLUSTER_LABEL_CONFIRM=yes \\
  node --env-file=.env.local --experimental-strip-types \\
  scripts/021_backfill_deterministic_labels.ts --apply`}</CodeBlock>
            <p className="mt-1 text-xs text-muted-foreground">
              The{" "}
              <code className="text-[11px]">CLUSTER_LABEL_CONFIRM=yes</code>{" "}
              env guard is required — the script refuses to write
              without it.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Before vs after expectations
          </CardTitle>
          <CardDescription>
            What you should see in the dashboard, and in a Supabase
            SQL query, after the apply step finishes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Before
              </p>
              <ul className="space-y-1 text-xs">
                <li>
                  Top Families cards show raw issue titles
                  (&ldquo;Cyber security issue&rdquo;, &ldquo;Codex
                  Desktop App: support Kitty&hellip;&rdquo;).
                </li>
                <li>
                  All cards carry a{" "}
                  <code className="text-[11px]">title fallback</code>{" "}
                  trust pill.
                </li>
                <li>
                  In Supabase:{" "}
                  <code className="text-[11px]">
                    select count(*) from clusters where label is null
                  </code>{" "}
                  returns &gt; 0.
                </li>
                <li>
                  <code className="text-[11px]">label_model</code>{" "}
                  distribution skews toward{" "}
                  <code className="text-[11px]">null</code> or{" "}
                  <code className="text-[11px]">fallback:title</code>.
                </li>
              </ul>
            </div>
            <div className="space-y-2 rounded-md border border-green-600/30 bg-green-50/40 p-3 dark:bg-green-950/20">
              <p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
                After
              </p>
              <ul className="space-y-1 text-xs">
                <li>
                  Top Families cards show family names like{" "}
                  <code className="text-[11px]">
                    Bug cluster &middot; ENOENT
                  </code>
                  ,{" "}
                  <code className="text-[11px]">
                    Performance cluster
                  </code>
                  , or{" "}
                  <code className="text-[11px]">
                    Issue family &middot; &lt;short title&gt;
                  </code>
                  .
                </li>
                <li>
                  Singletons keep their issue title (the{" "}
                  <code className="text-[11px]">SINGLETON</code>{" "}
                  badge tells you why).
                </li>
                <li>
                  <code className="text-[11px]">label IS NULL</code>{" "}
                  count drops to zero across the cluster table.
                </li>
                <li>
                  <code className="text-[11px]">label_model</code>{" "}
                  distribution shows the four deterministic rungs:{" "}
                  <code className="text-[11px]">
                    deterministic:topic-and-error
                  </code>
                  ,{" "}
                  <code className="text-[11px]">
                    deterministic:topic
                  </code>
                  ,{" "}
                  <code className="text-[11px]">
                    deterministic:error
                  </code>
                  ,{" "}
                  <code className="text-[11px]">
                    deterministic:title
                  </code>
                  .
                </li>
              </ul>
            </div>
          </div>

          <div>
            <p className="mb-1 font-medium">Verify in SQL</p>
            <p className="mb-2 text-xs text-muted-foreground">
              Run this in the Supabase SQL editor before and after the
              apply step. The post-apply distribution should have zero
              null rows.
            </p>
            <CodeBlock>{`select coalesce(label_model, '(null)') as label_model,
       count(*) as clusters
from clusters
group by label_model
order by clusters desc;`}</CodeBlock>
          </div>

          <div>
            <p className="mb-1 font-medium">Verify in the dashboard</p>
            <p className="text-xs text-muted-foreground">
              Re-run{" "}
              <code className="text-[11px]">
                scripts/dump_top_families.sql
              </code>{" "}
              and confirm the top 6 rows have non-null{" "}
              <code className="text-[11px]">label</code> and{" "}
              <code className="text-[11px]">label_confidence</code>{" "}
              values. Then load the dashboard&apos;s Top Families
              section and verify the cards no longer read like single
              issue titles for multi-issue clusters.
            </p>
          </div>
        </CardContent>
      </Card>

      <Alert>
        <AlertTitle>Safety notes</AlertTitle>
        <AlertDescription className="space-y-1 text-xs">
          <p>
            <span className="font-medium">Dry-run is read-only.</span>{" "}
            Only writes a local JSON file under{" "}
            <code className="text-[11px]">scripts/tmp/</code>. Safe to
            run any time, including from a stale repo checkout.
          </p>
          <p>
            <span className="font-medium">Apply is gated twice:</span>{" "}
            both the{" "}
            <code className="text-[11px]">--apply</code> flag and the{" "}
            <code className="text-[11px]">CLUSTER_LABEL_CONFIRM=yes</code>{" "}
            env var are required. Forgetting either one prints an
            error and exits without touching the database.
          </p>
          <p>
            <span className="font-medium">
              What it overwrites:
            </span>{" "}
            <code className="text-[11px]">clusters.label</code>,{" "}
            <code className="text-[11px]">label_confidence</code>,{" "}
            <code className="text-[11px]">label_model</code>, and{" "}
            <code className="text-[11px]">labeling_updated_at</code> —
            and only on rows that were already below 0.6 confidence.
            Members, observations, and fingerprints are untouched.
          </p>
          <p>
            <span className="font-medium">Service-role key:</span>{" "}
            don&apos;t paste it anywhere. Run only from a trusted
            local machine, and rotate the key in Supabase if you
            suspect exposure.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  )
}
