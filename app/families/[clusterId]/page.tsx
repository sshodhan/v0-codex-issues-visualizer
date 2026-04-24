"use client"

import Link from "next/link"
import { useParams, useSearchParams } from "next/navigation"
import useSWR from "swr"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ClusterTrustRibbon } from "@/components/dashboard/cluster-trust-ribbon"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type FamilyResponse = {
  family: {
    id: string
    label: string | null
    label_confidence: number | null
    fallback_title: string | null
    total_observations: number
    classified_count: number
    triage_coverage_ratio: number
    sentiment: { positive: number; neutral: number; negative: number }
    source_coverage: Array<{ source: string; count: number; share: number }>
    representative_observations: Array<{
      observation_id: string
      title: string | null
      url: string | null
      source_name: string | null
      impact_score: number | null
      error_code: string | null
      cluster_key_compound: string | null
    }>
    window_days: number | null
    reviewed_count: number
    cluster_path: "semantic" | "fallback"
    fingerprint_hit_rate: number
    dominant_error_code_share: number
    dominant_stack_frame_share: number
    intra_cluster_similarity_proxy: number
    nearest_cluster_gap_proxy: number
  } | null
  trend: Array<{ date: string; count: number }>
  variants: Array<{
    key: string
    error_code: string | null
    top_stack_frame_hash: string | null
    top_stack_frame: string | null
    count: number
    examples: string[]
  }>
}

export default function FamilyDetailPage() {
  const { clusterId } = useParams<{ clusterId: string }>()
  const searchParams = useSearchParams()
  const daysParam = searchParams.get("days") || "30"

  const { data, isLoading } = useSWR<FamilyResponse>(
    `/api/families/${clusterId}?days=${daysParam}`,
    fetcher,
  )

  if (isLoading || !data) return <main className="container mx-auto px-4 py-8">Loading family…</main>
  if (!data.family) return <main className="container mx-auto px-4 py-8">Family not found.</main>

  const familyName =
    data.family.label && (data.family.label_confidence ?? 0) >= 0.6
      ? data.family.label
      : data.family.fallback_title || "Unlabelled family"

  return (
    <main className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Family detail</p>
          <h1 className="text-3xl font-bold">{familyName}</h1>
          <p className="text-sm text-muted-foreground">
            Family = semantic/title fallback. Variant = regex fingerprint. Triage = LLM + review judgment.
          </p>
          <ClusterTrustRibbon cluster={data.family} />
        </div>
        <Button asChild variant="outline">
          <Link href={`/?cluster=${clusterId}`}>Open this family in dashboard table</Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardHeader><CardTitle className="text-sm">Family volume</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{data.family.total_observations}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Triage coverage</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{(data.family.triage_coverage_ratio * 100).toFixed(0)}%</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Variants</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{data.variants.length}</CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Within-family Variant strip</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {data.variants.map((variant) => (
              <Link key={variant.key} href={`/?fingerprint=${encodeURIComponent(variant.key)}`}>
                <Badge variant="outline" className="px-3 py-1 cursor-pointer hover:bg-muted">
                  {variant.error_code ?? "unknown"} · {variant.count}
                </Badge>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Family trend</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {data.trend.slice(-10).map((row) => (
              <div key={row.date} className="flex justify-between border-b pb-1"><span>{row.date}</span><span>{row.count}</span></div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Coverage by source</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {data.family.source_coverage.slice(0, 8).map((row) => (
              <div key={row.source} className="flex justify-between border-b pb-1"><span>{row.source}</span><span>{row.count} ({(row.share * 100).toFixed(0)}%)</span></div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Representative observations</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {data.family.representative_observations.map((row) => (
            <div key={row.observation_id} className="border-b pb-2">
              <p className="font-medium">{row.title}</p>
              <div className="text-xs text-muted-foreground flex gap-2 flex-wrap mt-1">
                <span>{row.source_name || "unknown source"}</span>
                {row.error_code ? <span>Variant key: {row.error_code}</span> : null}
                {row.url ? (
                  <a href={row.url} target="_blank" rel="noreferrer" className="underline">
                    source link
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  )
}
