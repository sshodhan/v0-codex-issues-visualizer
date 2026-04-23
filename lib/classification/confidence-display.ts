export type ConfidenceBand = "Stable" | "Verify" | "Human review required"

interface ConfidenceBandInput {
  confidence: number
  needsHumanReview?: boolean
  retriedWithLargeModel?: boolean
}

interface ConfidenceBandDisplay {
  band: ConfidenceBand
  summary: string
  nextAction: string
  modelScoreLabel: string
}

const STABLE_THRESHOLD = 0.85
const VERIFY_THRESHOLD = 0.7

export function getConfidenceBandDisplay({
  confidence,
  needsHumanReview = false,
  retriedWithLargeModel = false,
}: ConfidenceBandInput): ConfidenceBandDisplay {
  const clamped = Math.min(1, Math.max(0, confidence))
  const modelScoreLabel = `Model-reported score ${Math.round(clamped * 100)} (not calibrated probability)`

  if (needsHumanReview || clamped < VERIFY_THRESHOLD) {
    return {
      band: "Human review required",
      summary: retriedWithLargeModel
        ? "Classifier remained uncertain after large-model escalation."
        : "Classifier confidence is below the review threshold.",
      nextAction: "Route to human triage before taking action.",
      modelScoreLabel,
    }
  }

  if (clamped < STABLE_THRESHOLD) {
    return {
      band: "Verify",
      summary: "Signal is directionally useful but still uncertain.",
      nextAction: "Spot-check evidence and related issues before acting.",
      modelScoreLabel,
    }
  }

  return {
    band: "Stable",
    summary: "Model signal is internally consistent for queueing.",
    nextAction: "Proceed with normal triage flow and monitor for drift.",
    modelScoreLabel,
  }
}
