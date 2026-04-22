export interface FingerprintSurgeAggregateRow {
  error_code: string
  now_count: number
  prev_count: number
  delta: number
  sources: number
}

export function selectTopFingerprintSurges(rows: FingerprintSurgeAggregateRow[]) {
  const surges = [...rows]
    .filter((row) => row.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10)

  const new_in_window = surges
    .filter((row) => row.prev_count === 0)
    .map((row) => ({
      error_code: row.error_code,
      count: row.now_count,
      sources: row.sources,
    }))

  return { surges, new_in_window }
}
