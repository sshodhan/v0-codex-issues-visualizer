import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"

const reviewUpdateSchema = z.object({
  status: z.enum(["new", "triaged", "in-progress", "resolved", "wont-fix", "duplicate"]).optional(),
  category: z.string().optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  needs_human_review: z.boolean().optional(),
  reviewer_notes: z.string().optional(),
  reviewed_by: z.string().optional(),
})

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const payload = await request.json()
    const parsed = reviewUpdateSchema.safeParse(payload)

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 })
    }

    const updates = {
      ...parsed.data,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("bug_report_classifications")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update classification", detail: error instanceof Error ? error.message : "unknown_error" },
      { status: 500 }
    )
  }
}
