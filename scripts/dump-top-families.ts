// One-shot diagnostic: dumps the top 6 cluster rollup rows in the
// shape the dashboard's FamilyCard consumes, so we can render an
// accurate mock of "Top Families" before merging label/UX changes.
//
// Run:
//   DASHBOARD_URL=http://localhost:3000 DAYS=30 \
//     node --experimental-strip-types scripts/dump-top-families.ts
//
// If your dashboard requires an auth cookie, pass it through:
//   COOKIE='sb-access-token=…; sb-refresh-token=…' \
//     DASHBOARD_URL=https://your-app.vercel.app DAYS=30 \
//     node --experimental-strip-types scripts/dump-top-families.ts
//
// The output is a JSON blob with the six rows the dashboard would
// render in "Top Families". Paste it back into chat and I'll render
// the ASCII mocks from real data.

const base = process.env.DASHBOARD_URL ?? "http://localhost:3000"
const days = process.env.DAYS ?? "30"
const cookie = process.env.COOKIE ?? ""
const category = process.env.CATEGORY ?? "all"

const url = new URL(`${base.replace(/\/$/, "")}/api/clusters/rollup`)
url.searchParams.set("days", days)
if (category !== "all") url.searchParams.set("category", category)

async function main() {
  const res = await fetch(url, {
    headers: cookie ? { cookie } : undefined,
  })

  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText}`)
    console.error(await res.text())
    process.exit(1)
  }

  const body = (await res.json()) as {
    clusters: Array<Record<string, unknown>>
    pipeline_state?: Record<string, unknown>
  }

  // FamilyCard reads exactly these fields. Trim to keep the paste small
  // and to avoid leaking unrelated rollup metadata into the chat.
  const fields = [
    "id",
    "count",
    "classified_count",
    "reviewed_count",
    "source_count",
    "label",
    "label_confidence",
    "representative_title",
    "rail_scoring",
    "avg_impact",
    "cluster_path",
    "fingerprint_hit_rate",
    "dominant_error_code_share",
    "dominant_stack_frame_share",
    "intra_cluster_similarity_proxy",
    "nearest_cluster_gap_proxy",
  ] as const

  const top6 = body.clusters.slice(0, 6).map((row) => {
    const trimmed: Record<string, unknown> = {}
    for (const f of fields) trimmed[f] = row[f]
    return trimmed
  })

  console.log(
    JSON.stringify(
      {
        window_days: Number(days),
        category,
        top6,
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
