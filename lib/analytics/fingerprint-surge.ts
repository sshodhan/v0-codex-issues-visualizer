// Client-side projection over the rows returned by the SQL function
// `fingerprint_surges(window_hours)`. Kept as a pure function so the
// ranking logic is unit-testable without a Supabase client.
//
// Contract (matches docs/ARCHITECTURE.md §5.7 and the PR brief §3):
//   * `surges` ranks positive-delta rows by delta desc, ties by now_count
//     desc, capped at 10. Only delta > 0 qualifies — stable or declining
//     counts don't clutter the card.
//   * `new_in_window` lists rows with prev_count === 0 AND now_count > 0,
//     sorted by now_count desc. These are the "first appearance in the
//     previous 2N hours" signal; they are NOT a subset of `surges` in the
//     type sense but often overlap (a new code almost always surges).

export interface FingerprintSurgeAggregateRow {
  error_code: string
  now_count: number
  prev_count: number
  delta: number
  sources: number
}

export interface FingerprintSurgeNewRow {
  error_code: string
  count: number
  sources: number
}

export interface FingerprintSurgeResult {
  surges: FingerprintSurgeAggregateRow[]
  new_in_window: FingerprintSurgeNewRow[]
}

const MAX_SURGES = 10

export function selectTopFingerprintSurges(
  rows: FingerprintSurgeAggregateRow[],
): FingerprintSurgeResult {
  const surges = rows
    .filter((r) => r.delta > 0)
    .slice()
    .sort((a, b) => b.delta - a.delta || b.now_count - a.now_count)
    .slice(0, MAX_SURGES)

  const new_in_window = rows
    .filter((r) => r.prev_count === 0 && r.now_count > 0)
    .slice()
    .sort((a, b) => b.now_count - a.now_count)
    .map((r) => ({ error_code: r.error_code, count: r.now_count, sources: r.sources }))

  return { surges, new_in_window }
}
