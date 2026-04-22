import { NextResponse } from "next/server"
import { logServer } from "@/lib/error-tracking/server-logger"

// Secret gate for /api/admin/* routes.
//
// In production (Vercel's VERCEL_ENV === "production" or fallback to
// NODE_ENV === "production") the secret is REQUIRED — a missing
// ADMIN_SECRET env var returns 503 Misconfigured rather than silently
// opening the endpoints. The admin surface can write ~4N derivation rows
// and rebuild clustering across the whole DB, so the default must be
// fail-closed.
//
// In non-production environments the secret is optional so local dev
// without env vars still works.
export function requireAdminSecret(request: Request): NextResponse | null {
  const isProduction =
    process.env.VERCEL_ENV === "production" ||
    (!process.env.VERCEL_ENV && process.env.NODE_ENV === "production")
  const expected = process.env.ADMIN_SECRET
  const path = new URL(request.url).pathname

  if (!expected) {
    if (isProduction) {
      logServer({
        component: "admin-auth",
        event: "missing_secret_in_production",
        level: "error",
        data: { path, method: request.method },
      })
      return NextResponse.json(
        { error: "ADMIN_SECRET not configured" },
        { status: 503 },
      )
    }
    return null
  }

  if (request.headers.get("x-admin-secret") !== expected) {
    logServer({
      component: "admin-auth",
      event: "unauthorized",
      level: "warn",
      data: {
        path,
        method: request.method,
        hasHeader: request.headers.has("x-admin-secret"),
      },
    })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return null
}
