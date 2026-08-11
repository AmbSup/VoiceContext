import { NextResponse } from "next/server";

// Minimal CORS support for the three routes the mobile app calls
// cross-origin (realtime-token, retrieve, dialog-sessions/[id]/process).
// Native mobile builds never go through a browser and are unaffected by
// CORS either way; this is what lets a Flutter Web build (`flutter run -d
// chrome`) reach these same routes during local testing.
//
// Wildcard origin is safe here specifically because these routes gate
// access via an explicit Bearer token the client sends itself, not an
// ambient browser credential (cookie/session) — CORS only controls which
// origins may read the response, it isn't what's protecting the data.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function corsJson(
  body: unknown,
  init?: { status?: number },
): NextResponse {
  return NextResponse.json(body, { status: init?.status, headers: CORS_HEADERS });
}
