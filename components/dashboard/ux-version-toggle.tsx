"use client"

import { type DashboardUxVersion } from "@/lib/context/dashboard-ux-context"

export function UxVersionToggle() {
  // V3 is now the only version - toggle removed
  return null
}

export function isUxV2(v: DashboardUxVersion): v is "v2" {
  return v === "v2"
}
