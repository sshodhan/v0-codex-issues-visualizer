"use client"

import Link from "next/link"
import { format, parseISO } from "date-fns"
import { Clock, ArrowLeft } from "lucide-react"
import { Badge } from "@/components/ui/badge"

interface AsOfBannerProps {
  asOf: string | null
}

export function AsOfBanner({ asOf }: AsOfBannerProps) {
  if (!asOf) return null

  let formattedDate: string
  try {
    formattedDate = format(parseISO(asOf), "PPpp")
  } catch {
    formattedDate = asOf
  }

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20">
      <div className="container mx-auto flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-amber-600" />
          <span className="text-amber-700 dark:text-amber-400">
            Viewing replay of <strong>{formattedDate}</strong>
          </span>
          <Badge variant="outline" className="border-amber-500/30 text-amber-600 dark:text-amber-400">
            Historical
          </Badge>
        </div>
        <Link
          href="/"
          className="flex items-center gap-1 text-sm font-medium text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
        >
          <ArrowLeft className="h-3 w-3" />
          Return to live
        </Link>
      </div>
    </div>
  )
}
