import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import { logServerError } from "@/lib/error-tracking/server-logger"

// GET /api/admin/topic-review/categories
//
// Tiny helper for the admin Topic Review UI: returns the categories
// table so the override dropdown can render slugs/names. Categories are
// already public via /api/stats; this endpoint is here so the topic
// review surface is self-contained behind the admin secret.

export const maxDuration = 15

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, slug, color")
    .order("slug", { ascending: true })

  if (error) {
    logServerError("admin-topic-review", "categories_lookup_failed", error)
    return NextResponse.json(
      { error: "Categories lookup failed", detail: error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ categories: data ?? [] })
}
