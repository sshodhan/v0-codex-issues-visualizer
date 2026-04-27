import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"

function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

function clampShare(value: number) {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function summarizeTrustState(classifiedShare: number, reviewedShare: number, fingerprintHitRate: number) {
  const score = classifiedShare * 0.4 + reviewedShare * 0.4 + fingerprintHitRate * 0.2
  if (score >= 0.75) return { label: "High", badgeVariant: "default" as const }
  if (score >= 0.45) return { label: "Medium", badgeVariant: "secondary" as const }
  return { label: "Low", badgeVariant: "outline" as const }
}

export function TrustSummaryState({
  classifiedShare,
  reviewedShare,
  fingerprintHitRate,
}: {
  classifiedShare: number
  reviewedShare: number
  fingerprintHitRate: number
}) {
  const classified = clampShare(classifiedShare)
  const reviewed = clampShare(reviewedShare)
  const regexCoverage = clampShare(fingerprintHitRate)
  const trust = summarizeTrustState(classified, reviewed, regexCoverage)

  return (
    <div className="flex items-center justify-between rounded-sm border bg-muted/30 px-2 py-1.5">
      <p className="text-[11px] text-muted-foreground">Trust & completeness</p>
      <div className="flex items-center gap-2">
        <p className="text-[10px] text-muted-foreground">C {pct(classified)} · R {pct(reviewed)} · Rx {pct(regexCoverage)}</p>
        <Badge variant={trust.badgeVariant} className="text-[10px] leading-none">{trust.label}</Badge>
      </div>
    </div>
  )
}

function TrustBar({ label, value }: { label: string; value: number }) {
  const safeValue = clampShare(value)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span>{pct(safeValue)}</span>
      </div>
      <Progress value={safeValue * 100} className="h-1.5" />
    </div>
  )
}

export function TrustCompletenessBars({
  classifiedShare,
  reviewedShare,
  fingerprintHitRate,
}: {
  classifiedShare: number
  reviewedShare: number
  fingerprintHitRate: number
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Trust & Completeness</p>
      <TrustBar label="Classified" value={classifiedShare} />
      <TrustBar label="Human reviewed" value={reviewedShare} />
      <TrustBar label="Regex coverage" value={fingerprintHitRate} />
    </div>
  )
}
