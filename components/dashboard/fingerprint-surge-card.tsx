"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { FingerprintSurgeResponse } from "@/hooks/use-dashboard-data"

export function FingerprintSurgeCard({
  data,
  onFilter,
}: {
  data?: FingerprintSurgeResponse
  onFilter: (compoundKey: string) => void
}) {
  const surges = data?.surges ?? []
  const newInWindow = data?.new_in_window ?? []
  const [open, setOpen] = useState(surges.length > 0)

  const headline = useMemo(() => {
    if (surges.length === 0) return "No fingerprint surges in the last 24 h"
    return `${surges.length} fingerprints surging in the last 24 h · click to filter`
  }, [surges.length])

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold text-foreground">Fingerprint Surges</CardTitle>
            <p className="text-sm text-muted-foreground">{headline}</p>
          </div>
          <div className="flex items-center gap-2">
            {surges.length > 0 && (
              <Badge variant="outline" className="border-destructive/60 text-destructive">
                <AlertTriangle className="mr-1 h-3 w-3" />
                {surges.length} surging
              </Badge>
            )}
            <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} aria-label="Toggle surge details">
              {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          {surges.length === 0 ? (
            <p className="text-sm text-muted-foreground">No error-code spikes detected for the selected window.</p>
          ) : (
            surges.map((surge) => (
              <div key={surge.error_code} className="flex items-center justify-between rounded-md border border-border p-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono border-destructive/60 text-destructive">
                    {surge.error_code}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    now {surge.now_count} vs prev {surge.prev_count} · {surge.sources} sources
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">+{surge.delta}</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onFilter(`err:${surge.error_code}`)}
                  >
                    Drill in
                  </Button>
                </div>
              </div>
            ))
          )}
          {newInWindow.length > 0 && (
            <div className="pt-1">
              <p className="mb-1 text-xs text-muted-foreground">New in window</p>
              <div className="flex flex-wrap gap-1">
                {newInWindow.map((row) => (
                  <Badge key={row.error_code} variant="outline" className="font-mono">
                    {row.error_code} ({row.count})
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
