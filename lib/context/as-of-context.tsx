"use client"

import { createContext, useContext, type ReactNode } from "react"

interface AsOfContextValue {
  asOf: string | null
}

const AsOfContext = createContext<AsOfContextValue>({ asOf: null })

export function AsOfProvider({
  asOf,
  children,
}: {
  asOf: string | null
  children: ReactNode
}) {
  return (
    <AsOfContext.Provider value={{ asOf }}>
      {children}
    </AsOfContext.Provider>
  )
}

export function useAsOf(): string | null {
  return useContext(AsOfContext).asOf
}
