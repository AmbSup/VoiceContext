import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Excludes /api: the mobile app authenticates those routes itself via a
  // Bearer token (see api/realtime-token/route.ts), not cookies — running
  // the cookie-based redirect over it would turn a 401 JSON response into
  // an HTML redirect to /login.
  //
  // Excludes /auth: auth/confirm/route.ts must run for a signed-out visitor
  // (that's the whole point — it's what signs them in). Without this
  // exclusion, updateSession would see "no user yet" and redirect to
  // /login before verifyOtp ever runs, silently dropping the token_hash.
  matcher: ["/((?!api|auth|_next/static|_next/image|favicon.ico).*)"],
};
