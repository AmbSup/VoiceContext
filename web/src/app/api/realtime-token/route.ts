import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

// Mints a short-lived OpenAI Realtime API token for the mobile app's next
// Dialog-Session (see ADR 0001, docs/implementation-plan.md Phase 2). The
// mobile app connects to OpenAI directly over WebRTC with this token — the
// OPENAI_API_KEY itself never leaves this server.
//
// Called cross-origin by the Flutter app (not the web UI), so auth comes
// from a Supabase access token in the Authorization header, not cookies —
// see web/src/lib/supabase/server.ts for the cookie-based variant used by
// the Next.js pages themselves.
//
// OpenAI reference: POST /v1/realtime/client_secrets
// https://developers.openai.com/api/docs/api-reference/realtime-sessions/create-realtime-client-secret

const REALTIME_MODEL = "gpt-realtime";
const TOKEN_LIFETIME_SECONDS = 600;

export async function POST(request: Request) {
  const accessToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");

  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(accessToken);

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com";

  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const openaiResponse = await fetch(`${baseUrl}/v1/realtime/client_secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Ties the session to our own user id for OpenAI-side abuse monitoring.
      "OpenAI-Safety-Identifier": user.id,
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: TOKEN_LIFETIME_SECONDS },
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              silence_duration_ms: 500,
            },
            // Without this, conversation.item.input_audio_transcription.*
            // events never fire and the user's half of the transcript stays
            // empty (mobile's RealtimeDialogController._recordTranscript
            // listens for the .completed event). Placement confirmed via
            // the Realtime API docs for a dedicated transcription session;
            // NOT yet verified against a live "type": "realtime" session —
            // check this first if the transcript comes back user-less.
            transcription: { model: "gpt-transcribe" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: "alloy",
          },
        },
        // TODO(Phase 2/3): instructions + tools for the drei Dialogzustaende
        // (zuhoeren/antworten/nachfragen) and live-targeted Retrieval — see
        // CONTEXT.md "Dialogzustand" and "Aktiver Kontext".
        output_modalities: ["audio"],
        // Phase 0 requirement (docs/implementation-plan.md): tracing is not
        // EU-residency-conform, so it must stay off independent of the
        // pending OpenAI EU-residency approval itself.
        tracing: null,
      },
    }),
  });

  if (!openaiResponse.ok) {
    const detail = await openaiResponse.text();
    return NextResponse.json(
      { error: "Failed to mint Realtime token", detail },
      { status: 502 },
    );
  }

  const { value, expires_at } = await openaiResponse.json();
  return NextResponse.json({
    token: value,
    expiresAt: expires_at,
    // Keeps WebRTC signaling on the same regional OpenAI API origin that
    // minted the client secret (for example the configured EU endpoint).
    realtimeUrl: `${baseUrl}/v1/realtime/calls`,
  });
}
