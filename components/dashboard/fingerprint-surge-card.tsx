"use client"

import { useEffect, useMemo, useState } from "react"
import { Activity, ChevronDown, ChevronUp, Sparkles, TrendingUp, CheckCircle2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  FingerprintModelDialog,
  MethodologyTriggerButton,
} from "@/components/dashboard/methodology-dialogs"
import type { FingerprintSurgeResponse } from "@/hooks/use-dashboard-data"

// FingerprintSurgeCard — the "is something breaking right now?" widget.
// Sits between the HeroInsight and the PriorityMatrix on the dashboard so
// an analyst sees rising error codes before they click into the priority
// lanes below. The copy is active voice ("N fingerprints surging, click
// to filter") rather than "insights available" — the point of the card is
// to drive action, not to hedge.
//
// Collapses to a single-line header when no fingerprints are surging,
// expands automatically when surges arrive via an SWR revalidation.
// An analyst can toggle manually either way.

interface FingerprintSurgeCardProps {
  data?: FingerprintSurgeResponse
  windowHours?: number
  // Called with the surge card's drill-down token. Always starts with
  // `err:` since the card's unit is "error code" not "specific cluster";
  // /api/issues treats `err:<code>` as a segment-anchored
  // cluster_key_compound match so any title/frame combination sharing the
  // code is returned.
  onFilter: (compoundKey: string) => void
  /** Shown in header; comparison unit matches backend (day-based MV) */
  windowLabelForCopy?: string
  /** V1: original copy only; V2: methodology sublabel + dialog */
  variant?: "v1" | "v2"
}

export function FingerprintSurgeCard({
  data,
  windowHours = 24,
  onFilter,
  windowLabelForCopy,
  variant = "v2",
}: FingerprintSurgeCardProps) {
  const [fingerprintInfoOpen, setFingerprintInfoOpen] = useState(false)
  const surges = data?.surges ?? []
  const newInWindow = data?.new_in_window ?? []
  const hasAnything = surges.length > 0 || newInWindow.length > 0

  // Start collapsed; auto-expand the first time SWR returns something worth
  // looking at. Manual toggles after that stick — we don't want the card
  // re-expanding on every revalidate once the analyst has dismissed it.
  const [open, setOpen] = useState<boolean>(hasAnything)
  const [userToggled, setUserToggled] = useState(false)
  useEffect(() => {
    if (!userToggled && hasAnything && !open) setOpen(true)
    // Intentionally does NOT collapse when hasAnything goes false — the
    // transient empty state during a revalidate shouldn't slam the card
    // shut on an analyst who just opened it.
  }, [hasAnything, open, userToggled])
  const toggle = () => {
    setUserToggled(true)
    setOpen((v) => !v)
  }

  // The SQL function rounds window_hours up to whole days (the MV is
  // day-granular). Prefer the server's reported `window_days` so copy
  // matches what the data actually compares.
  const windowDays = data?.window_days ?? Math.max(1, Math.ceil(windowHours / 24))
  const windowLabel =
    windowLabelForCopy ||
    (windowDays === 1 ? "today vs yesterday" : `last ${windowDays} days`)

  const headline = useMemo(() => {
    if (surges.length === 0 && newInWindow.length === 0) {
      return "All clear"
    }
    const parts: string[] = []
    if (surges.length > 0) parts.push(`${surges.length} spiking`)
    if (newInWindow.length > 0) parts.push(`${newInWindow.length} new`)
    return parts.join(" · ")
  }, [surges.length, newInWindow.length])

  // Calculate max delta for relative bar sizing
  const maxDelta = useMemo(() => {
    if (surges.length === 0) return 1
    return Math.max(...surges.map((s) => s.delta), 1)
  }, [surges])

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
              Trending Errors
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {headline}
              {hasAnything && <span className="text-muted-foreground/70"> · {windowLabel}</span>}
            </p>
            {variant === "v2" && (
              <MethodologyTriggerButton
                label="How this works"
                onClick={() => setFingerprintInfoOpen(true)}
                className="h-auto p-0 text-xs"
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={open ? "Collapse details" : "Expand details"}
              aria-expanded={open}
            >
              {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          {!hasAnything ? (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <div className="rounded-full bg-emerald-500/10 p-3 mb-3">
                <CheckCircle2 className="h-6 w-6 text-emerald-500" />
              </div>
              <p className="text-sm font-medium text-foreground">No spikes detected</p>
              <p className="text-xs text-muted-foreground mt-1">
                Error rates are stable compared to {windowLabel}
              </p>
              <p className="text-xs text-muted-foreground mt-3">
                Current status: <span className="font-medium text-emerald-600 dark:text-emerald-400">all clear</span> · Last Sync: {data?.last_synced ? new Date(data.last_synced).toLocaleString() : "—"}
              </p>
            </div>
          ) : (
            <>
              {surges.length > 0 && (
                <div className="space-y-2" role="list" aria-label="Spiking error codes">
                  {surges.map((surge) => {
                    const barWidth = Math.max(20, (surge.delta / maxDelta) * 100)
                    return (
                      <button
                        key={surge.error_code}
                        type="button"
                        onClick={() => onFilter(`err:${surge.error_code}`)}
                        className="group w-full text-left rounded-lg border border-border bg-muted/30 p-3 hover:bg-muted/50 hover:border-destructive/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Error code ${surge.error_code}, up ${surge.delta} from ${surge.prev_count} to ${surge.now_count}. Click to filter.`}
                      >
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2">
                            <code className="text-sm font-mono font-semibold text-foreground">
                              {surge.error_code}
                            </code>
                            <Badge variant="outline" className="border-destructive/60 text-destructive text-xs px-1.5 py-0">
                              <TrendingUp className="h-3 w-3 mr-1" />
                              +{surge.delta}
                            </Badge>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {surge.sources} source{surge.sources === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-destructive/70 rounded-full transition-all duration-300"
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground w-16 text-right">
                            {surge.prev_count} → {surge.now_count}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}

              {newInWindow.length > 0 && (
                <div className={surges.length > 0 ? "pt-2 border-t border-border" : ""}>
                  <p className="mb-2 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Sparkles className="h-3 w-3 text-amber-500" />
                    New this period
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {newInWindow.map((row) => (
                      <button
                        key={row.error_code}
                        type="button"
                        onClick={() => onFilter(`err:${row.error_code}`)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-sm font-mono text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`New error code ${row.error_code} with ${row.count} occurrences. Click to filter.`}
                      >
                        {row.error_code}
                        <span className="text-xs opacity-70">({row.count})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}

      {variant === "v2" && (
        <FingerprintModelDialog
          open={fingerprintInfoOpen}
          onOpenChange={setFingerprintInfoOpen}
        />
      )}
    </Card>
  )
}
