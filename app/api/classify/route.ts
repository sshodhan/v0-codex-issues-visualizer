import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  classifyInputSchema,
  classifyReport,
  ClassificationValidationError,
} from "@/lib/classification/pipeline"

export async function POST(request: Request) {
  try {
    const json = await request.json()
    const parsed = classifyInputSchema.safeParse(json)

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 })
    }

    const supabase =
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
        ? createAdminClient()
        : null

    const result = await classifyReport(parsed.data, { supabase })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof ClassificationValidationError) {
      return NextResponse.json(
        {
          error: "Invalid classification output",
          detail: error.message,
        },
        { status: error.status },
      )
    }

    return NextResponse.json(
      {
        error: "Classification failed",
        detail: error instanceof Error ? error.message : "unknown_error",
      },
      { status: 500 }
    )
  }
}
