import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  selectTopFingerprintSurges,
  type FingerprintSurgeAggregateRow,
} from "@/lib/analytics/fingerprint-surge"

// GET /api/fingerprints/surge?window_hours=24
//
// Read-time surge detection backed by the SQL function
// `fingerprint_surges(window_hours int)` introduced in migration 014. The
// function reads off `mv_fingerprint_daily` so this route is O(distinct
// error_codes in the last 60 days) — independent of total observation
// volume.
//
// The payload pairs rank-ordered `surges` (top 10 by delta) with a
// companion `new_in_window` list for error codes that had zero prior-
// window activity. The fingerprint-surge card renders them together so
// analysts see both "spiking" and "first-seen" breakage at a glance.
//
// window_hours is clamped: 1h as a sanity floor, 720h (30d) as a ceiling
// because the MV only covers 60 days.
export async function GET(request: NextRequest) {
  const raw = Number(request.nextUrl.searchParams.get("window_hours"))
  const windowHours = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 1), 720) : 24

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("fingerprint_surges", {
    window_hours: windowHours,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Postgres bigint round-trips as string over the wire in some supabase-js
  // versions; coerce defensively so the downstream delta-sort math doesn't
  // silently compare "10" < "2".
  const rows: FingerprintSurgeAggregateRow[] = ((data ?? []) as any[]).map((r) => ({
    error_code: String(r.error_code),
    now_count: Number(r.now_count) || 0,
    prev_count: Number(r.prev_count) || 0,
    delta: Number(r.delta) || 0,
    sources: Number(r.sources) || 0,
  }))

  const payload = selectTopFingerprintSurges(rows)
  return NextResponse.json({ ...payload, window_hours: windowHours })
}
