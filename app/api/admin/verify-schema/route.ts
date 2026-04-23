import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireAdminSecret } from "@/lib/admin/auth"
import {
  diffSnapshot,
  EXPECTED_MANIFEST,
  type SchemaSnapshot,
} from "@/lib/schema/expected-manifest"
import { logServerError } from "@/lib/error-tracking/server-logger"

export const maxDuration = 30

export async function GET(request: NextRequest) {
  const authErr = requireAdminSecret(request)
  if (authErr) return authErr

  const supabase = createAdminClient()

  const { data, error } = await supabase.rpc("get_schema_snapshot")

  if (error) {
    // The RPC ships with migration 015. If it's missing, that itself is
    // a verification failure: the operator hasn't applied the verifier
    // migration. Return a structured 200 explaining this rather than a
    // 500, so the UI can render an actionable message.
    const missingRpc =
      error.code === "PGRST202" ||
      /function .*get_schema_snapshot.* does not exist/i.test(error.message ?? "")
    if (missingRpc) {
      return NextResponse.json(
        {
          snapshotAt: new Date().toISOString(),
          summary: { total: 1, pass: 0, fail: 1 },
          checks: [
            {
              kind: "function",
              name: "get_schema_snapshot",
              expected: "exists",
              actual: "missing",
              status: "fail",
              group: "verifier",
              hint: "Apply scripts/015_schema_verifier.sql.",
            },
          ],
        },
        { status: 200 },
      )
    }
    logServerError("admin-verify-schema", "rpc_failed", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const snapshot = data as SchemaSnapshot
  const report = diffSnapshot(snapshot, EXPECTED_MANIFEST)

  return NextResponse.json(report, {
    // Don't cache — the whole point is a fresh check on demand.
    headers: { "cache-control": "no-store" },
  })
}
