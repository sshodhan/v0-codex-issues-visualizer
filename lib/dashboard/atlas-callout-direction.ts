/**
 * Pick the leader-line direction with the most clearance for a bubble's external label.
 *
 * The previous heuristic was "outward from canvas center" — fine when the labelled bubble
 * is on the periphery, but it collapses when the bubble *is* the canvas center (largest
 * bubble in a deterministic spiral pack always lands there). The collapsed unit vector
 * defaults to pointing right, which lands the label on top of the next bubble in the
 * spiral. Same failure mode for the "Other" bucket when it ends up near the centre.
 *
 * This picker samples eight cardinal/diagonal directions and scores each by:
 *   - Distance from the leader endpoint to the nearest *other* bubble (we want clearance)
 *   - Distance from the leader endpoint to the canvas edges (we want to stay onscreen)
 *
 * The winning direction is the one that maximises the *minimum* of those two — i.e. the
 * direction that is simultaneously far from neighbours and inside the canvas.
 */

export interface BubbleGeom {
  x: number
  y: number
  r: number
}

export interface CalloutDirection {
  ux: number
  uy: number
}

export interface PickCalloutOptions {
  /** Distance from the bubble centre to the leader endpoint (i.e. where the label anchors). */
  leaderLength: number
  /** Canvas dimensions for edge-clearance scoring. */
  canvas: { width: number; height: number }
  /** Padding from the canvas edge that the leader endpoint should respect. */
  edgePad?: number
  /** Approximate horizontal half-width of the label so we don't push it off-screen. */
  labelHalfWidth?: number
  /** Tie-breaker: prefer this direction when scores are within `tieEps` of each other. */
  preferred?: CalloutDirection
  tieEps?: number
}

const EIGHT_DIRECTIONS: CalloutDirection[] = [
  { ux: 1, uy: 0 },
  { ux: 0.7071, uy: -0.7071 },
  { ux: 0, uy: -1 },
  { ux: -0.7071, uy: -0.7071 },
  { ux: -1, uy: 0 },
  { ux: -0.7071, uy: 0.7071 },
  { ux: 0, uy: 1 },
  { ux: 0.7071, uy: 0.7071 },
]

export function pickCalloutDirection(
  bubble: BubbleGeom,
  others: BubbleGeom[],
  options: PickCalloutOptions,
): CalloutDirection {
  const {
    leaderLength,
    canvas,
    edgePad = 4,
    labelHalfWidth = 0,
    preferred,
    tieEps = 1,
  } = options

  const score = (d: CalloutDirection): number => {
    const lx = bubble.x + d.ux * leaderLength
    const ly = bubble.y + d.uy * leaderLength

    // Edge clearance: account for the label extending sideways.
    const xExtent = labelHalfWidth * (d.ux >= 0 ? 1 : -1)
    const xCheck = lx + xExtent
    const edgeDist = Math.min(
      lx - edgePad,
      canvas.width - edgePad - lx,
      ly - edgePad,
      canvas.height - edgePad - ly,
      xCheck - edgePad,
      canvas.width - edgePad - xCheck,
    )

    // Closest neighbour edge — distance from the label endpoint to the nearest
    // bubble's outline. Bubbles other than the labelled one only.
    let nearest = Infinity
    for (const o of others) {
      if (o === bubble) continue
      const d2 = Math.hypot(lx - o.x, ly - o.y) - o.r
      if (d2 < nearest) nearest = d2
    }
    if (others.length === 0) nearest = 1000 // no neighbours → effectively infinite clearance

    // The minimum of the two is what counts: a direction with great neighbour clearance
    // but off-screen is useless, and vice versa.
    return Math.min(edgeDist, nearest)
  }

  let bestDir = EIGHT_DIRECTIONS[0]
  let bestScore = score(bestDir)
  for (let i = 1; i < EIGHT_DIRECTIONS.length; i++) {
    const d = EIGHT_DIRECTIONS[i]
    const s = score(d)
    if (s > bestScore + tieEps) {
      bestScore = s
      bestDir = d
    }
  }

  // Tie-break: if a preferred direction is within tieEps of the winner, prefer it.
  if (preferred) {
    const pScore = score(preferred)
    if (pScore >= bestScore - tieEps) {
      return preferred
    }
  }

  return bestDir
}
