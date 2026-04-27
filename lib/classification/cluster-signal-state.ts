import { SURGE_CHIP_THRESHOLD_PCT } from "./rollup-constants.ts"

export type ClusterSignalState = "strong" | "emerging" | "uncertain"

export interface ClusterSignalStateInput {
  count: number
  source_count?: number
  regex_variants?: Array<{ kind: "err" | "stack" | "env" | "sdk"; value: string }>
  surge_delta_pct?: number | null
  fingerprint_hit_rate?: number
  cluster_path: "semantic" | "fallback"
  classified_share?: number
  human_reviewed_share?: number
}

export interface ClusterSignalStateViewModel {
  state: ClusterSignalState
  badgeLabel: string
  badgeClassName: string
  explanation: string
  ctaLabel: string
  ctaHref: string
  suppressConfidentNarrative: boolean
}

export function deriveClusterSignalState(input: ClusterSignalStateInput): ClusterSignalStateViewModel {
  const regexCount = input.regex_variants?.length ?? 0
  const regexKindCount = new Set((input.regex_variants ?? []).map((v) => v.kind)).size
  const sourceCount = input.source_count ?? 0
  const reviewedShare = input.human_reviewed_share ?? 0
  const classifiedShare = input.classified_share ?? 0
  const surge = input.surge_delta_pct ?? null
  const fingerprintHitRate = input.fingerprint_hit_rate ?? 0

  const hasNonTrivialRegexCoverage = regexCount >= 3 && regexKindCount >= 2
  const hasStrongVolume = input.count >= 10
  const hasMultiSource = sourceCount >= 2

  if (hasStrongVolume && hasMultiSource && hasNonTrivialRegexCoverage) {
    return {
      state: "strong",
      badgeLabel: "Strong",
      badgeClassName: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300 text-[10px]",
      explanation: "High volume across multiple sources with repeatable fingerprint patterns.",
      ctaLabel: "Open family",
      ctaHref: "family",
      suppressConfidentNarrative: false,
    }
  }

  const countIsEmergingBand = input.count >= 3 && input.count <= 12
  const hasSurge = surge != null && surge >= SURGE_CHIP_THRESHOLD_PCT
  const hasConcentratedFingerprint = fingerprintHitRate >= 0.6 || (regexCount >= 2 && regexKindCount >= 1)

  if (countIsEmergingBand && (hasSurge || hasConcentratedFingerprint)) {
    return {
      state: "emerging",
      badgeLabel: "Emerging",
      badgeClassName: "border-amber-500/40 text-amber-700 dark:text-amber-300 text-[10px]",
      explanation: hasSurge
        ? "Early cluster with a sharp recent increase; monitor before it broadens."
        : "Early cluster with a concentrated fingerprint signal in a smaller sample.",
      ctaLabel: "Review triage",
      ctaHref: "triage",
      suppressConfidentNarrative: false,
    }
  }

  const lowEvidence = input.count < 6 || regexCount < 2 || sourceCount < 2
  const lowReviewCoverage = reviewedShare < 0.25 || classifiedShare < 0.5
  if (input.cluster_path === "fallback" || (lowEvidence && lowReviewCoverage)) {
    return {
      state: "uncertain",
      badgeLabel: "Uncertain",
      badgeClassName: "border-border text-muted-foreground text-[10px]",
      explanation: "Limited corroboration so far; treat this grouping as directional until more evidence lands.",
      ctaLabel: "Validate cluster",
      ctaHref: "triage",
      suppressConfidentNarrative: true,
    }
  }

  return {
    state: "emerging",
    badgeLabel: "Emerging",
    badgeClassName: "border-amber-500/40 text-amber-700 dark:text-amber-300 text-[10px]",
    explanation: "Signal is building but still needs broader evidence and review coverage.",
    ctaLabel: "Review triage",
    ctaHref: "triage",
    suppressConfidentNarrative: false,
  }
}
