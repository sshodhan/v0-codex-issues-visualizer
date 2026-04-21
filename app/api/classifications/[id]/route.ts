import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { recordClassificationReview } from "@/lib/storage/derivations"

// Reviewer PATCH appends to classification_reviews (append-only).
// The LLM baseline row in `classifications` is immutable; every reviewer
// action — including revisions of earlier decisions — is retained.
// See docs/ARCHITECTURE.md v10 §§3.3, 5.2.
const reviewUpdateSchema = z.object({
  status: z.enum(["new", "triaged", "in-progress", "resolved", "wont-fix", "duplicate"]).optional(),
  category: z.string().optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  needs_human_review: z.boolean().optional(),
  reviewer_notes: z.string().optional(),
  reviewed_by: z.string().min(1),
})

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const payload = await request.json()
    const parsed = reviewUpdateSchema.safeParse(payload)

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 })
    }

    const supabase = createAdminClient()
    const reviewId = await recordClassificationReview(supabase, id, parsed.data)
    if (!reviewId) {
      return NextResponse.json({ error: "Failed to record review" }, { status: 500 })
    }

    return NextResponse.json({ data: { id: reviewId, classification_id: id, ...parsed.data } })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to record review", detail: error instanceof Error ? error.message : "unknown_error" },
      { status: 500 }
    )
  }
}
