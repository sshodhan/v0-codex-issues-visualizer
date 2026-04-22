import { NextResponse } from "next/server"

// Optional secret gate for /api/admin/* routes.
// When ADMIN_SECRET is set, every request must carry a matching
// x-admin-secret header. When unset, routes are open (same posture as
// /api/scrape) so local dev without env vars still works.
export function requireAdminSecret(request: Request): NextResponse | null {
  const expected = process.env.ADMIN_SECRET
  if (!expected) return null
  if (request.headers.get("x-admin-secret") !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return null
}
