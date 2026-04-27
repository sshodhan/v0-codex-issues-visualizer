/**
 * Picks the bubble worthy of an editorial callout in the atlas — same idea as the peak-day
 * annotation on the timeline, but for the category cloud. Returns null when no single
 * category is dominant enough to be newsworthy (avoids fabricating drama).
 *
 * A bubble qualifies when it carries either (a) a meaningful share of the total signal
 * (default ≥ 30%), or (b) a clear lead over the second-largest (default ≥ 1.4×). Either
 * condition alone is enough — a category with 28% share but 3× the runner-up is still
 * worth annotating.
 */

export interface AtlasAnnotationCandidate {
  /** Slug used to match against `selectedHeuristicSlug`/`selectedLlmCategorySlug`. */
  slug: string
  /** Human label as shown on the bubble. */
  label: string
  count: number
  /** 0..1 share of total in the rows passed in. */
  share: number
  color?: string
}

export interface AtlasAnnotationOptions {
  /** Minimum share-of-total to qualify (default 0.3). */
  minShare?: number
  /** Minimum lead over the second-largest count to qualify (default 1.4). */
  minLeadOverSecond?: number
  /** Resolves a row to a slug. Called when no `slug` field is present on the row. */
  toSlug?: (name: string) => string
}

interface AnnotationRow {
  name: string
  count: number
  color?: string
  slug?: string
}

const DEFAULT_TO_SLUG = (name: string) => name.toLowerCase().replace(/\s+/g, "-")

export function pickAtlasAnnotation(
  rows: AnnotationRow[],
  options: AtlasAnnotationOptions = {},
): AtlasAnnotationCandidate | null {
  const minShare = options.minShare ?? 0.3
  const minLead = options.minLeadOverSecond ?? 1.4
  const toSlug = options.toSlug ?? DEFAULT_TO_SLUG

  if (rows.length === 0) return null
  const total = rows.reduce((s, r) => s + Math.max(0, r.count), 0)
  if (total <= 0) return null

  const sorted = [...rows]
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
  if (sorted.length === 0) return null
  const top = sorted[0]
  const second = sorted[1]
  const share = top.count / total
  const lead = second && second.count > 0 ? top.count / second.count : Infinity

  if (share < minShare && lead < minLead) return null

  return {
    slug: top.slug ?? toSlug(top.name),
    label: top.name,
    count: top.count,
    share,
    color: top.color,
  }
}
