"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

export type DashboardUxVersion = "v1" | "v2"

const STORAGE_KEY = "codex-dashboard-ux-version"

const DashboardUxContext = createContext<{
  version: DashboardUxVersion
  setVersion: (v: DashboardUxVersion) => void
} | null>(null)

function parseParam(raw: string | null): DashboardUxVersion | null {
  if (raw === "v1" || raw === "v2") return raw
  return null
}

export function DashboardUxProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [version, setVersionState] = useState<DashboardUxVersion>("v2")

  // URL wins, then localStorage; default v2. Sync `?ux=` from storage when missing so links are shareable.
  useEffect(() => {
    const fromUrl = parseParam(searchParams.get("ux"))
    if (fromUrl) {
      setVersionState(fromUrl)
      if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, fromUrl)
      return
    }
    if (typeof window === "undefined") return
    const stored = parseParam(localStorage.getItem(STORAGE_KEY))
    if (stored) {
      setVersionState(stored)
      const next = new URLSearchParams(searchParams.toString())
      next.set("ux", stored)
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    }
  }, [pathname, router, searchParams])

  const setVersion = useCallback(
    (v: DashboardUxVersion) => {
      setVersionState(v)
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, v)
      }
      const next = new URLSearchParams(searchParams.toString())
      next.set("ux", v)
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const value = useMemo(() => ({ version, setVersion }), [version, setVersion])

  return (
    <DashboardUxContext.Provider value={value}>{children}</DashboardUxContext.Provider>
  )
}

export function useDashboardUxVersion() {
  const ctx = useContext(DashboardUxContext)
  if (!ctx) {
    throw new Error("useDashboardUxVersion must be used within DashboardUxProvider")
  }
  return ctx
}
