"use client"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { type DashboardUxVersion, useDashboardUxVersion } from "@/lib/context/dashboard-ux-context"
import { Badge } from "@/components/ui/badge"

export function UxVersionToggle() {
  const { version, setVersion } = useDashboardUxVersion()
  const isV2 = version === "v2"

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border/80 bg-muted/40 px-2 py-1.5"
      title="Toggles the insight-first layout (V2) vs. the original dashboard (V1). Persists in local storage and the URL (ux=)."
    >
      <span className="text-xs text-muted-foreground hidden sm:inline">UI</span>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground w-5 text-center">V1</span>
        <Label htmlFor="ux-version-switch" className="sr-only">
          Dashboard user interface version
        </Label>
        <Switch
          id="ux-version-switch"
          checked={isV2}
          onCheckedChange={(checked) => setVersion(checked ? "v2" : "v1")}
        />
        <span className="text-xs font-medium text-foreground w-5 text-center">V2</span>
      </div>
      <Badge variant="secondary" className="text-[10px] px-1.5 font-normal">
        {version.toUpperCase()}
      </Badge>
    </div>
  )
}

export function isUxV2(v: DashboardUxVersion): v is "v2" {
  return v === "v2"
}
