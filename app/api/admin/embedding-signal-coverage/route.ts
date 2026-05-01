import { NextRequest, NextResponse } from "next/server"
import { requireAdminSecret } from "@/lib/admin/auth"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  buildCoveragePreview,
  summarizeEmbeddingSignalCoverage,
  type EmbeddingSignalCoverageRow,
} from "@/lib/embeddings/signal-coverage"

const DEFAULT_LIMIT = 5000
const MAX_LIMIT = 20000

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const limitRaw = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, MAX_LIMIT)) : DEFAULT_LIMIT
  const includePreview = request.nextUrl.searchParams.get("include_preview") === "true"
  const previewLimitRaw = Number.parseInt(request.nextUrl.searchParams.get("preview_limit") ?? "50", 10)
  const previewLimit = Number.isFinite(previewLimitRaw) ? Math.max(1, Math.min(previewLimitRaw, 500)) : 50

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from("mv_observation_current")
    .select(
      "observation_id, title, content, category_slug, error_code, top_stack_frame, cli_version, fp_os, fp_shell, fp_editor, model_id, llm_category, llm_subcategory, llm_primary_tag, llm_confidence, llm_review_status",
    )
    .eq("is_canonical", true)
    .order("captured_at", { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as EmbeddingSignalCoverageRow[]
  const summary = summarizeEmbeddingSignalCoverage(rows)

  const preview = includePreview ? buildCoveragePreview(rows.slice(0, previewLimit)) : undefined

  return NextResponse.json({
    sampled_rows: rows.length,
    limit,
    include_preview: includePreview,
    summary,
    preview,
  })
}
