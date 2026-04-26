import { NextResponse } from "next/server"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { recordClassificationReview } from "@/lib/storage/derivations"
import { recordProcessingEvent } from "@/lib/storage/processing-events"

// Reviewer PATCH appends to classification_reviews (append-only).
// The LLM baseline row in `classifications` is immutable; every reviewer
// action — including revisions of earlier decisions — is retained.
// See docs/ARCHITECTURE.md v10 §§3.3, 5.2.
const reviewUpdateSchema = z.object({
  status: z.enum(["new", "triaged", "in-progress", "resolved", "wont-fix", "duplicate"]).optional(),
  category: z.string().optional(),
  // Reviewer can override the LLM mechanism slug independently of category.
  // 60-char cap mirrors classifications.subcategory (schema.ts maxLength: 60).
  subcategory: z.string().min(1).max(60).optional(),
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
    const { data: classificationRow } = await supabase
      .from("classifications")
      .select("observation_id")
      .eq("id", id)
      .maybeSingle()
    const reviewId = await recordClassificationReview(supabase, id, parsed.data)
    if (!reviewId) {
      return NextResponse.json({ error: "Failed to record review" }, { status: 500 })
    }
    if (classificationRow?.observation_id) {
      await recordProcessingEvent(supabase, {
        observationId: classificationRow.observation_id,
        stage: "review",
        status: "completed",
        algorithmVersionModel: "human-review",
        detail: {
          classification_id: id,
          review_id: reviewId,
          reviewed_by: parsed.data.reviewed_by,
          status: parsed.data.status ?? null,
        },
      })
    }

    return NextResponse.json({ data: { id: reviewId, classification_id: id, ...parsed.data } })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to record review", detail: error instanceof Error ? error.message : "unknown_error" },
      { status: 500 }
    )
  }
}
