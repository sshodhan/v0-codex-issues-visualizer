import { createHash } from "node:crypto"

// Pure helpers for cluster-key derivation. Kept in its own module so the
// fingerprint extractor (lib/scrapers/bug-fingerprint.ts) and the
// aggregation-layer RPCs (lib/storage/clusters.ts) can both import these
// without creating a circular dependency.
//
// Clustering is an aggregation-layer concern. Evidence rows are never mutated
// by attach/detach — only cluster_members is written. See
// docs/ARCHITECTURE.md v10 §§3.1c, 5.3, 4.7.

/**
 * Normalize a title for cluster-key derivation. Unicode-aware so non-Latin
 * titles produce stable keys rather than collapsing to an empty bucket
 * (addresses the P1-12 failure mode from the previous design).
 */
export function normalizeTitleForCluster(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Deterministic title-only cluster key. MD5 of the normalized form,
 * prefixed so the column is self-describing. Empty titles collapse to
 * "title:empty" but this is rare once Unicode normalization is in place.
 *
 * Compound keys (title + fingerprint) are built by
 * `buildCompoundClusterKey` in lib/scrapers/bug-fingerprint.ts, which
 * appends `|err:<code>|frame:<hash>` suffixes to this base key.
 */
export function buildTitleClusterKey(title: string): string {
  const normalized = normalizeTitleForCluster(title)
  if (!normalized) return "title:empty"
  const hash = createHash("md5").update(normalized).digest("hex").slice(0, 16)
  return `title:${hash}`
}
