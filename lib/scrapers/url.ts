// URL canonicalization for second-tier ingest dedup.
//
// The evidence layer uniqueness key is `(source_id, external_id)`, which
// correctly dedups within a single submission stream. It does NOT catch the
// case of one canonical article being submitted multiple times to the same
// source — e.g. an HN re-submission gets a fresh `objectID` even though the
// destination URL is identical. Without a second-tier dedup the
// `observations` table accumulates near-duplicate rows, which inflate counts
// and create false 2-member semantic clusters at cosine ≈ 0.99.
//
// canonicalizeUrl produces a stable string for the "is this the same outbound
// content?" question. The implementation is intentionally conservative:
//
//   * Lowercases the host and strips a leading `www.` (cosmetic equivalence).
//   * Removes a trailing slash from the path (so `/foo` and `/foo/` collapse).
//   * Strips known tracking query parameters (utm_*, gclid, fbclid, mc_*,
//     ref, source). Functional params like `id`, `page`, `q` are preserved
//     because some sources rely on them as part of the canonical URL.
//   * Drops the fragment (`#section`) since servers do not see it.
//
// Anything that does not parse as a URL falls through to the original string —
// the caller passes raw strings through untouched rather than crashing.

const TRACKING_PARAM_PATTERN = /^(?:utm_|mc_)|^(?:gclid|fbclid|ref|source)$/i

export function canonicalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return trimmed
  }

  parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase()
  parsed.protocol = parsed.protocol.toLowerCase()
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/"

  const params = parsed.searchParams
  for (const key of Array.from(params.keys())) {
    if (TRACKING_PARAM_PATTERN.test(key)) params.delete(key)
  }
  // URLSearchParams.sort() gives us stable equality across submissions that
  // happened to include the same params in different order.
  params.sort()
  parsed.search = params.toString() ? `?${params.toString()}` : ""
  parsed.hash = ""

  return parsed.toString()
}
