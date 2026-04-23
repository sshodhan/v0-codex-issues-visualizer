/**
 * Deterministic bubble pack for Story “category atlas”: radii from counts, spiral placement.
 * No randomness — same inputs yield the same layout.
 */

export interface CountBubble {
  id: string
  label: string
  count: number
  sublabel?: string
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * @param maxCount — largest count is used implicitly via item.count
 */
export function countBubbles(
  items: CountBubble[],
  options: { maxR: number; minR: number; width: number; height: number },
): Array<CountBubble & { x: number; y: number; r: number }> {
  const { maxR, minR, width, height } = options
  if (items.length === 0) return []
  const maxCount = Math.max(...items.map((i) => i.count), 1)
  const cy = height / 2
  const cx = width / 2

  const withR = items.map((it) => ({
    ...it,
    r: clamp(minR + (it.count / maxCount) * (maxR - minR), minR, maxR),
  }))
  withR.sort((a, b) => b.r - a.r)

  const placed: Array<CountBubble & { x: number; y: number; r: number }> = []
  const first = withR[0]!
  placed.push({ ...first, x: cx, y: cy })

  const spiral = (idx: number) => {
    const t = idx * 0.85
    const radius = 8 + t * 6
    return { x: cx + Math.cos(t) * radius, y: cy + Math.sin(t) * radius * 0.75 }
  }

  for (let i = 1; i < withR.length; i++) {
    const b = withR[i]!
    let { x, y } = spiral(i)
    let guard = 0
    while (guard < 200) {
      let overlap = false
      for (const p of placed) {
        const d = Math.hypot(x - p.x, y - p.y)
        if (d < p.r + b.r + 4) {
          overlap = true
          break
        }
      }
      if (!overlap) break
      guard++
      const t = (i + guard) * 0.9
      const radius = 10 + t * 5
      x = cx + Math.cos(t) * radius
      y = cy + Math.sin(t) * radius * 0.75
    }
    const pad = b.r + 4
    placed.push({
      ...b,
      x: clamp(x, pad, width - pad),
      y: clamp(y, pad, height - pad),
    })
  }
  return placed
}

export function formatLlmCategorySlug(name: string): string {
  return name.trim().toLowerCase()
}

export function heuristicNameToSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-")
}
