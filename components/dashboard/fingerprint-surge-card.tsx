"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, ChevronDown, ChevronUp, Sparkles } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { FingerprintSurgeResponse } from "@/hooks/use-dashboard-data"

// FingerprintSurgeCard — the "is something breaking right now?" widget.
// Sits between the HeroInsight and the PriorityMatrix on the dashboard so
// an analyst sees rising error codes before they click into the priority
// lanes below. The copy is active voice ("N fingerprints surging, click
// to filter") rather than "insights available" — the point of the card is
// to drive action, not to hedge.
//
// Collapses to a single-line header when no fingerprints are surging,
// expands by default when there is at least one. An analyst can toggle
// manually either way.

interface FingerprintSurgeCardProps {
  data?: FingerprintSurgeResponse
  windowHours?: number
  // Called with the surge card's drill-down token. Always starts with
  // `err:` since the card's unit is "error code" not "specific cluster";
  // /api/issues treats `err:<code>` as a cluster_key_compound substring
  // match so any title/frame combination sharing the code is returned.
  onFilter: (compoundKey: string) => void
}

export function FingerprintSurgeCard({
  data,
  windowHours = 24,
  onFilter,
}: FingerprintSurgeCardProps) {
  const surges = data?.surges ?? []
  const newInWindow = data?.new_in_window ?? []
  const [open, setOpen] = useState<boolean>(surges.length > 0 || newInWindow.length > 0)

  const headline = useMemo(() => {
    if (surges.length === 0 && newInWindow.length === 0) {
      return `No fingerprint surges in the last ${windowHours} h — no error codes are spiking.`
    }
    if (surges.length === 0) {
      return `${newInWindow.length} new error code${newInWindow.length === 1 ? "" : "s"} seen in the last ${windowHours} h · click to filter`
    }
    return `${surges.length} fingerprint${surges.length === 1 ? "" : "s"} surging in the last ${windowHours} h · click to filter`
  }, [surges.length, newInWindow.length, windowHours])

  const hasAnything = surges.length > 0 || newInWindow.length > 0

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
              Fingerprint Surges
            </CardTitle>
            <p className="text-sm text-muted-foreground">{headline}</p>
          </div>
          <div className="flex items-center gap-2">
            {surges.length > 0 && (
              <Badge variant="outline" className="border-destructive/60 text-destructive">
                {surges.length} surging
              </Badge>
            )}
            {newInWindow.length > 0 && (
              <Badge variant="outline" className="border-amber-500/60 text-amber-500">
                <Sparkles className="mr-1 h-3 w-3" aria-hidden />
                {newInWindow.length} new
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Collapse surge details" : "Expand surge details"}
              aria-expanded={open}
            >
              {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          {!hasAnything ? (
            <p className="text-sm text-muted-foreground">
              No error-code spikes detected for the selected window. Healthy state.
            </p>
          ) : (
            <>
              {surges.length > 0 && (
                <ul className="space-y-2" aria-label="Top fingerprint surges">
                  {surges.map((surge) => (
                    <li
                      key={surge.error_code}
                      className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge
                          variant="outline"
                          className="font-mono border-destructive/60 text-destructive"
                        >
                          {surge.error_code}
                        </Badge>
                        <span className="text-xs text-muted-foreground truncate">
                          {surge.now_count} now vs {surge.prev_count} prior · {surge.sources}{" "}
                          source{surge.sources === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Badge variant="secondary" className="font-mono">
                          +{surge.delta}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onFilter(`err:${surge.error_code}`)}
                          aria-label={`Drill into observations with error code ${surge.error_code}`}
                        >
                          Drill in
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {newInWindow.length > 0 && (
                <div className="pt-1 border-t border-border">
                  <p className="mb-1 text-xs text-muted-foreground">
                    New in window (no activity in the prior {windowHours} h):
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {newInWindow.map((row) => (
                      <button
                        key={row.error_code}
                        type="button"
                        onClick={() => onFilter(`err:${row.error_code}`)}
                        className="inline-flex rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Drill into new error code ${row.error_code}`}
                      >
                        <Badge variant="outline" className="font-mono border-amber-500/60 text-amber-500">
                          {row.error_code} ({row.count})
                        </Badge>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
