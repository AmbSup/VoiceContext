import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { corsJson, corsPreflight } from "@/lib/cors";

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

// The three Dialogzustaende from CONTEXT.md ("Dialogzustand"), driven by
// Function-Calling rather than plain prompting so the client (mobile's
// RealtimeDialogController) gets a structured, reliable signal instead of
// having to parse spoken/text output. "Aktiver Kontext" (CONTEXT.md) is
// deliberately NOT implemented yet — retrieve_memory searches the whole
// Context Space, same as web/src/app/search. Realtime API tool schemas
// are flat ({type, name, description, parameters}), unlike Chat
// Completions' nested {type: "function", function: {...}}.
const TOOLS = [
  {
    type: "function",
    name: "set_dialog_state",
    description:
      'Muss als erster Funktionsaufruf in JEDER Antwort-Runde aufgerufen werden, bevor du (falls überhaupt) sprichst oder eine weitere Funktion aufrufst. Legt fest, in welchem der drei Dialogzustände du gerade agierst.',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: {
          type: "string",
          enum: ["zuhoeren", "antworten", "nachfragen"],
          description:
            'zuhoeren: reine Erfassung, der Nutzer hat nur etwas mitgeteilt oder nachgedacht, keine Antwort nötig — danach NICHT sprechen, und frag insbesondere NICHT, ob du dir das merken sollst (das passiert automatisch, unabhängig von einer Antwort darauf). antworten: der Nutzer hat eine echte Frage gestellt. Kannst du sie direkt aus dem bisherigen Verlauf DIESES Gesprächs beantworten (z. B. weil er die nötige Info gerade selbst genannt hat), antworte direkt, ohne retrieve_memory. Brauchst du dafür Wissen aus FRÜHEREN Sessions oder bereits gespeichertes Wissen, das nicht Teil dieses Gesprächs ist, rufe vorher retrieve_memory auf. nachfragen: du bist dir bei etwas Wesentlichem unsicher (z. B. worauf sich eine Aussage bezieht) und stellst eine kurze, gezielte Rückfrage — danach direkt sprechen, ohne retrieve_memory.',
        },
      },
      required: ["state"],
    },
  },
  {
    type: "function",
    name: "retrieve_memory",
    description:
      'Durchsucht bereits gespeichertes Wissen aus FRÜHEREN Gesprächen, Dokumenten und Notizen per Vektorsuche — NICHT für Dinge, die der Nutzer gerade erst in diesem laufenden Gespräch gesagt hat (die stehen bereits im Gesprächsverlauf, dafür brauchst du diese Funktion nicht). Nur aufrufen, nachdem set_dialog_state mit state="antworten" aufgerufen wurde, und nur wenn die Antwort wirklich Wissen von außerhalb dieses Gesprächs braucht. Formuliere die query als Suchbegriffe für das, wonach du suchst — nicht zwangsläufig die Nutzerfrage wörtlich.',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Suchanfrage in Stichworten oder als kurzer Satz.",
        },
      },
      required: ["query"],
    },
  },
] as const;

function buildInstructions(): string {
  return `Du bist die Live-Dialog-KI der KI Voice Context Engine — einer persönlichen Wissens-App. Der Nutzer spricht frei mit dir, wie mit einem Kollegen im Auto. Alles, was er sagt, wird als Wissen erfasst (nachgelagert, nicht live — darum musst du dich nicht kümmern, und frag ihn auch nie, ob du dir etwas merken sollst: das passiert automatisch im Hintergrund, unabhängig davon, was er auf so eine Frage antworten würde).

In jeder Antwort-Runde gehst du so vor:
1. Rufe zuerst IMMER set_dialog_state auf und wähle genau einen der drei Zustände:
   - "zuhoeren": Der Nutzer berichtet, denkt laut nach, trifft eine Aussage oder Entscheidung — es gibt nichts, worauf du sinnvoll antworten müsstest. Sprich in diesem Fall danach NICHT — keine Bestätigung, kein Kommentar, keine Nachfrage, und insbesondere keine Frage, ob du dir das merken sollst.
   - "antworten": Der Nutzer stellt eine echte Frage. Kannst du sie direkt aus dem bisherigen Verlauf DIESES Gesprächs beantworten — z. B. weil er die nötige Info gerade eben selbst genannt hat —, antworte direkt, ohne retrieve_memory; dafür ist dein normales Gesprächsgedächtnis da. Rufe retrieve_memory nur auf, wenn die Antwort Wissen aus FRÜHEREN Sessions oder bereits gespeichertes Wissen braucht, das nicht Teil dieses Gesprächs ist, und stütze dich dann ausschließlich auf das, was retrieve_memory liefert. Findet retrieve_memory nichts Passendes, sag das ehrlich, statt zu raten oder aus allgemeinem Wissen zu antworten.
   - "nachfragen": Du bist dir bei etwas Wesentlichem unsicher, das die Antwort oder die spätere Einordnung des Gesagten betrifft. Stell danach direkt eine kurze, gezielte Rückfrage — keine Retrieval nötig.
2. Sei bei "antworten" und "nachfragen" kurz und gesprochen-natürlich, wie im echten Gespräch, nicht wie ein Textdokument.
3. Antworte ausschließlich auf Deutsch.`;
}

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request) {
  const accessToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");

  if (!accessToken) {
    return corsJson({ error: "Not authenticated" }, { status: 401 });
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
    return corsJson({ error: "Not authenticated" }, { status: 401 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com";

  if (!apiKey) {
    return corsJson(
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
        instructions: buildInstructions(),
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
        tools: TOOLS,
        tool_choice: "auto",
        // Best-effort, not a hard guarantee: nothing in the Realtime API
        // forces zero audio output for a given response, we can only
        // instruct the model strongly (see buildInstructions) not to speak
        // when state="zuhoeren". If this turns out too leaky in practice,
        // revisit with turn_detection.create_response: false and having
        // the client decide when to call response.create instead.
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
    return corsJson(
      { error: "Failed to mint Realtime token", detail },
      { status: 502 },
    );
  }

  const { value, expires_at } = await openaiResponse.json();
  return corsJson({
    token: value,
    expiresAt: expires_at,
    // Keeps WebRTC signaling on the same regional OpenAI API origin that
    // minted the client secret (for example the configured EU endpoint).
    realtimeUrl: `${baseUrl}/v1/realtime/calls`,
  });
}
