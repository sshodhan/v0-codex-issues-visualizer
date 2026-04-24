"use client"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { type DashboardUxVersion, useDashboardUxVersion } from "@/lib/context/dashboard-ux-context"
import { Badge } from "@/components/ui/badge"

export function UxVersionToggle() {
  const { version, setVersion } = useDashboardUxVersion()

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border/80 bg-muted/40 px-2 py-1.5"
      title="Selects the dashboard UI version (V1, V2, or V3). Persists in local storage and the URL (ux=)."
    >
      <span className="text-xs text-muted-foreground hidden sm:inline">UI</span>
      <span className="sr-only">Dashboard user interface version</span>
      <ToggleGroup
        id="ux-version-toggle"
        type="single"
        variant="outline"
        size="sm"
        value={version}
        onValueChange={(next) => {
          if (next === "v1" || next === "v2" || next === "v3") {
            setVersion(next)
          }
        }}
        aria-label="Dashboard user interface version"
      >
        <ToggleGroupItem value="v1" aria-label="Version 1">
          V1
        </ToggleGroupItem>
        <ToggleGroupItem value="v2" aria-label="Version 2">
          V2
        </ToggleGroupItem>
        <ToggleGroupItem value="v3" aria-label="Version 3">
          V3
        </ToggleGroupItem>
      </ToggleGroup>
      <Badge variant="secondary" className="text-[10px] px-1.5 font-normal">
        {version.toUpperCase()}
      </Badge>
    </div>
  )
}

export function isUxV2(v: DashboardUxVersion): v is "v2" {
  return v === "v2"
}
