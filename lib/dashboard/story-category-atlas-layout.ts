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
 * Generic so callers can carry extra fields (color, rawSlug, etc.) through layout
 * without losing their types.
 *
 * @param maxCount — largest count is used implicitly via item.count
 */
export function countBubbles<T extends CountBubble>(
  items: T[],
  options: { maxR: number; minR: number; width: number; height: number },
): Array<T & { x: number; y: number; r: number }> {
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

  const placed: Array<T & { x: number; y: number; r: number }> = []
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

/**
 * Categorical palette for LLM bubbles. Mid-lightness (≈OKLch L 0.6) so labels stay readable
 * against light or dark mode without recoloring. Hues spread roughly evenly around the wheel.
 */
const LLM_PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#14b8a6", // teal
  "#6366f1", // indigo
  "#a855f7", // purple
  "#0ea5e9", // sky
  "#22c55e", // green
] as const

function fnv1a(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

/** Deterministic color for an LLM category name. Same input → same hue across renders. */
export function llmColorForName(name: string): string {
  const idx = fnv1a(name.toLowerCase()) % LLM_PALETTE.length
  return LLM_PALETTE[idx]
}

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "")
  const expanded = h.length === 3 ? h.split("").map((c) => c + c).join("") : h
  if (expanded.length !== 6) return null
  const r = parseInt(expanded.slice(0, 2), 16)
  const g = parseInt(expanded.slice(2, 4), 16)
  const b = parseInt(expanded.slice(4, 6), 16)
  if ([r, g, b].some(Number.isNaN)) return null
  return [r, g, b]
}

/**
 * Pick a high-contrast text color for a given fill. Accepts hex or `oklch(L ...)` strings.
 * Returns near-black for light fills, near-white for dark fills (WCAG AA target on the fill).
 */
export function readableTextColor(fill: string): "#0b1220" | "#ffffff" {
  if (!fill) return "#ffffff"
  const trimmed = fill.trim()
  const rgb = trimmed.startsWith("#") ? hexToRgb(trimmed) : null
  if (rgb) {
    const [r, g, b] = rgb.map((c) => {
      const cs = c / 255
      return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
    })
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return lum > 0.5 ? "#0b1220" : "#ffffff"
  }
  const m = trimmed.match(/oklch\(\s*([0-9.]+)/i)
  if (m) {
    const L = Number(m[1])
    return L > 0.65 ? "#0b1220" : "#ffffff"
  }
  return "#ffffff"
}
