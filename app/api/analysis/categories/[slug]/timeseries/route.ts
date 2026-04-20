import { NextResponse } from "next/server"
import { CATEGORY_BY_SLUG, categoryTimeseries } from "@/lib/analysis/data"

export const dynamic = "force-static"

export function GET(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const cat = CATEGORY_BY_SLUG[params.slug]
  if (!cat) {
    return NextResponse.json(
      { detail: `Category '${params.slug}' not found` },
      { status: 404 },
    )
  }
  const points = categoryTimeseries(params.slug)
  if (!points || points.length === 0) {
    return NextResponse.json(
      { detail: `No timeseries for '${params.slug}'` },
      { status: 404 },
    )
  }
  const peak = points.reduce((min, p) => (p.sentiment < min.sentiment ? p : min), points[0])
  const recovery = points.reduce(
    (max, p) => (p.sentiment > max.sentiment ? p : max),
    points[0],
  )
  return NextResponse.json({ category: cat, points, peak, recovery })
}
