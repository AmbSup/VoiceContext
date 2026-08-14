import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getConfirmedActiveContext } from "@/lib/active-context";
import { corsJson, corsPreflight } from "@/lib/cors";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";

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
// having to parse spoken/text output. The confirmed active context is loaded
// into this session; explicitly named alternatives are temporary retrieval
// scopes, while permanent changes require a two-step tool confirmation.
// Realtime API tool schemas
// are flat ({type, name, description, parameters}), unlike Chat
// Completions' nested {type: "function", function: {...}}.
//
// Shared by retrieve_memory and search_context_and_web below — both hit the
// same hybrid-retrieval backend (api/retrieve/route.ts) and take the same
// optional Metadatenfilter, so the schema fragment is defined once to keep
// the (long) memory_type enum from drifting between the two copies.
const RETRIEVAL_FILTER_PROPERTIES = {
  context_name: {
    type: "string",
    description:
      'Optional: nur innerhalb dieses vom Nutzer genannten Kontexts suchen, so wie gesagt (z. B. "Sport Erfolge"). Nur setzen, wenn ein Kontext eindeutig genannt wurde.',
  },
  memory_type: {
    type: "string",
    enum: [
      "fakt",
      "entscheidung",
      "aufgabe",
      "idee",
      "annahme",
      "offene_frage",
      "ziel",
      "risiko",
      "person",
      "termin",
      "ergebnis",
      "erkenntnis",
    ],
    description: "Optional: nur diesen Memory-Item-Typ berücksichtigen.",
  },
  occurred_from: {
    type: "string",
    description: "Optional: ISO-Datum, nur Einträge ab diesem Zeitpunkt.",
  },
  occurred_to: {
    type: "string",
    description: "Optional: ISO-Datum, nur Einträge bis zu diesem Zeitpunkt.",
  },
} as const;

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
            'zuhoeren: reine Erfassung, der Nutzer hat nur etwas mitgeteilt oder nachgedacht, keine Antwort nötig — danach NICHT sprechen, und frag insbesondere NICHT, ob du dir das merken sollst (das passiert automatisch, unabhängig von einer Antwort darauf). antworten: der Nutzer hat eine echte Frage gestellt. Hat er die nötige Info WÖRTLICH gerade eben selbst in diesem Gespräch genannt, antworte direkt daraus, ohne weitere Funktionsaufrufe. Fragt er nach dem INHALT eines bestimmten, benannten Kontexts (z. B. "was ist alles in Sport Erfolge", "liste meine Elemente in X"), rufe list_context_items auf. In JEDEM anderen Fall — auch und gerade wenn du glaubst, die Antwort nicht zu kennen, UND AUCH wenn dir ein genannter Name (Firma, Person, o. Ä.) aus deinem Trainingswissen bekannt vorkommt — rufe ZUERST retrieve_memory auf; verwende NIE allgemeines Trainingswissen über eine dem Nutzer gehörende Firma/Person/Sache als Ersatz für einen echten Funktionsaufruf, das Fehlen einer Info in diesem Gespräch heißt nicht, dass sie nicht aus einer früheren Session gespeichert ist. nachfragen: du bist dir bei etwas Wesentlichem unsicher (z. B. worauf sich eine Aussage bezieht) und stellst eine kurze, gezielte Rückfrage — danach direkt sprechen, ohne weitere Funktionsaufrufe.',
        },
      },
      required: ["state"],
    },
  },
  {
    type: "function",
    name: "retrieve_memory",
    description:
      'Durchsucht bereits gespeichertes Wissen aus FRÜHEREN Gesprächen, Dokumenten und Notizen per Hybrid-Suche (Embeddings + Volltextsuche, sowohl einzelne Memory-Items als auch Kontext-Beschreibungen und zusammenhängende Text-Abschnitte aus Dokumenten/Notizen für ausführlichere Antworten) — NICHT für Dinge, die der Nutzer gerade erst in diesem laufenden Gespräch gesagt hat (die stehen bereits im Gesprächsverlauf, dafür brauchst du diese Funktion nicht). Ohne context_name wird automatisch zuerst im bestätigten aktiven Kontext gesucht; nur wenn dort nichts passt, erweitert das Backend kontrolliert auf den Context Space. Ein ausdrücklich genannter anderer context_name gilt nur für diesen Aufruf als temporärer Fokus und ändert den Standard nicht. Nur aufrufen, nachdem set_dialog_state mit state="antworten" aufgerufen wurde, und nur wenn die Antwort wirklich Wissen von außerhalb dieses Gesprächs braucht. Formuliere die query als Suchbegriffe für das, wonach du suchst — nicht zwangsläufig die Nutzerfrage wörtlich. context_name/memory_type/occurred_from/occurred_to sind optional und engen die Suche ein — nur setzen, wenn die Frage sie eindeutig hergibt, sonst weglassen statt zu raten. Enthält das Ergebnis "ambiguous_context" oder "context_not_found", wurde NICHT gesucht — wechsle zu state="nachfragen" und kläre den Kontext, statt zu raten.',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Suchanfrage in Stichworten oder als kurzer Satz.",
        },
        ...RETRIEVAL_FILTER_PROPERTIES,
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "list_context_items",
    description:
      'Listet alle Memory-Items in einem bestimmten, vom Nutzer BENANNTEN Kontext auf (strukturiert, keine Ähnlichkeitssuche) — für Anfragen wie "was ist alles im Kontext Sport Erfolge", "sag mir alle meine Elemente in X", "liste den Kontext Y auf". NICHT für thematische Fragen ohne genannten Kontextnamen — dafür ist retrieve_memory da. Nur aufrufen, nachdem set_dialog_state mit state="antworten" aufgerufen wurde.',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        context_name: {
          type: "string",
          description:
            'Der vom Nutzer genannte Kontext-Name, so wie gesagt (z. B. "Sport Erfolge").',
        },
      },
      required: ["context_name"],
    },
  },
  {
    type: "function",
    name: "propose_active_context_switch",
    description:
      "Bereitet einen dauerhaften Wechsel des Standardkontexts vor, speichert ihn aber noch NICHT. Rufe dies nur auf, wenn der Nutzer ausdrücklich dauerhaft zu einem benannten Kontext wechseln möchte. Nach dem Ergebnis musst du den Nutzer kurz um Ja/Nein-Bestätigung bitten.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        context_name: {
          type: "string",
          description: "Name des gewünschten neuen Standardkontexts.",
        },
      },
      required: ["context_name"],
    },
  },
  {
    type: "function",
    name: "confirm_active_context_switch",
    description:
      "Bestätigt den zuvor vorbereiteten Wechsel. Nur aufrufen, wenn direkt zuvor ein Wechsel vorgeschlagen wurde und der Nutzer jetzt eindeutig zustimmt. Ohne ausstehenden Vorschlag wird nichts geändert.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: "function",
    name: "cancel_active_context_switch",
    description:
      "Verwirft einen zuvor vorbereiteten Kontextwechsel. Nur bei ausdrücklicher Ablehnung oder Korrektur durch den Nutzer aufrufen.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: "function",
    name: "search_web",
    description:
      "Durchsucht das öffentliche Internet. Verwende diese Funktion für aktuelle Informationen (z. B. Nachrichten, Wetter, Preise, Fahrpläne oder heutige Ereignisse) und für allgemeine externe Wissensfragen, deren Antwort nicht aus dem laufenden Gespräch oder dem persönlichen gespeicherten Wissen des Nutzers kommen soll. Formuliere die query als vollständige, präzise Suchfrage.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Präzise Suchfrage für das öffentliche Internet.",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "search_context_and_web",
    description:
      'Durchsucht mit derselben Frage ZWINGEND sowohl das persönliche gespeicherte Wissen des Nutzers als auch das öffentliche Internet. Verwende diese Funktion für Vergleiche, Bewertungen oder Empfehlungen, die persönliche Projekte, Pläne, Firmen, Entscheidungen oder Notizen MIT aktuellen beziehungsweise externen Informationen verbinden sollen. Beispiele: "Vergleiche unsere Strategie mit aktuellen Markttrends", "Passt mein gespeicherter Reiseplan zum heutigen Wetter?", "Prüfe mein Vorhaben gegen den aktuellen Stand". Nicht durch getrennte Einzelaufrufe ersetzen. Ohne context_name startet der persönliche Teil im aktiven Kontext und erweitert nur bei null Treffern auf den Context Space. Ein ausdrücklich genannter context_name ist nur ein temporärer Fokus. Nur nach set_dialog_state mit state="antworten" aufrufen. memory_type/occurred_from/occurred_to engen ebenfalls nur den persönlichen Kontext-Teil ein. Enthält das Ergebnis "personal_context.ambiguous_context" oder "personal_context.context_not_found", wechsle zu state="nachfragen" statt zu antworten.',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Vollständige Frage, die sowohl gegen den persönlichen Context als auch gegen aktuelle externe Quellen geprüft werden soll.",
        },
        ...RETRIEVAL_FILTER_PROPERTIES,
      },
      required: ["query"],
    },
  },
] as const;

function buildInstructions(activeContextName?: string): string {
  const activeContextInstruction = activeContextName
    ? `Der bestätigte Standardkontext ist "${activeContextName}". Suche persönliche Informationen standardmäßig zuerst dort. Nennt der Nutzer für eine einzelne Frage eindeutig einen anderen Kontext, verwende diesen als temporären Fokus über context_name, ohne den Standard zu ändern. Ein dauerhafter Wechsel erfolgt ausschließlich über propose_active_context_switch und nach einem späteren eindeutigen Ja über confirm_active_context_switch.`
    : "Es ist noch kein Standardkontext bestätigt. Suche ohne expliziten Kontext im gesamten Context Space. Einen dauerhaften Standard darfst du nur über propose_active_context_switch und eine spätere eindeutige Bestätigung setzen.";

  return `Du bist die Live-Dialog-KI der KI Voice Context Engine — einer persönlichen Wissens-App. Der Nutzer spricht frei mit dir, wie mit einem Kollegen im Auto. Alles, was er sagt, wird als Wissen erfasst (nachgelagert, nicht live — darum musst du dich nicht kümmern, und frag ihn auch nie, ob du dir etwas merken sollst: das passiert automatisch im Hintergrund, unabhängig davon, was er auf so eine Frage antworten würde).

${activeContextInstruction}

In jeder Antwort-Runde gehst du so vor:
1. Rufe zuerst IMMER set_dialog_state auf und wähle genau einen der drei Zustände:
   - "zuhoeren": Der Nutzer berichtet, denkt laut nach, trifft eine Aussage oder Entscheidung — es gibt nichts, worauf du sinnvoll antworten müsstest. Sprich in diesem Fall danach NICHT — keine Bestätigung, kein Kommentar, keine Nachfrage, und insbesondere keine Frage, ob du dir das merken sollst. WICHTIG: "zuhoeren" ist NICHT dasselbe wie "ich konnte akustisch nichts Sinnvolles verstehen". Wirkt der übermittelte Text bruchstückhaft, unzusammenhängend, in einer falschen Sprache oder wie ein Transkriptionsfehler (z. B. einzelne, für sich unsinnige Wörter statt eines erkennbaren Satzes) — das ist ein Verständnisproblem, kein "zuhoeren"-Fall. Wähle dann stattdessen "nachfragen" und bitte kurz um Wiederholung (z. B. "Das habe ich akustisch nicht verstanden, kannst du das wiederholen?"), statt einfach zu schweigen.
   - "antworten": Der Nutzer stellt eine echte Frage. Nur wenn er die nötige Info WÖRTLICH gerade eben selbst in diesem Gespräch genannt hat, antworte direkt daraus, ohne weitere Funktionsaufrufe; dafür ist dein normales Gesprächsgedächtnis da. Nennt der Nutzer einen konkreten Kontext-Namen und will ausschließlich dessen Inhalt wissen (z. B. "was ist alles in Sport Erfolge"), rufe list_context_items auf. Verlangt die Frage einen Vergleich, eine Bewertung oder eine Empfehlung, bei der persönliches gespeichertes Wissen UND aktuelle beziehungsweise externe Informationen nötig sind, rufe IMMER search_context_and_web auf. Verwende dafür nicht nur retrieve_memory oder nur search_web. Geht es ausschließlich um aktuelle öffentliche Informationen (z. B. Nachrichten, Wetter, Preise, Fahrpläne oder heutige Ereignisse) oder ausschließlich um eine allgemeine Frage über die Außenwelt, rufe search_web auf. Geht es ausschließlich um das persönliche Wissen, die Projekte, Firmen, Personen, Entscheidungen oder Notizen des Nutzers, rufe retrieve_memory auf — AUCH wenn dir ein Name aus deinem Trainingswissen bekannt vorkommt. Verwende NIE allgemeines Trainingswissen als Ersatz für einen passenden Funktionsaufruf. NENN NIEMALS "unter welchem Kontext hast du das gespeichert" oder Ähnliches als Rückfrage/Grund zum Zögern: retrieve_memory durchsucht automatisch den aktiven Kontext mit Fallback auf den gesamten Context Space und braucht dafür KEINEN bekannten Kontext-/Ordnernamen — formuliere stattdessen einfach eine thematische Suchanfrage (z. B. "sportliche Erfolge") und rufe retrieve_memory direkt auf. Stütze deine Antwort ausschließlich auf das laufende Gespräch und die gelieferten Funktionsergebnisse. Nach search_context_and_web unterscheide inhaltlich klar zwischen "In deinem Context" und "Aus aktuellen externen Informationen" und leite anschließend ein gemeinsames Fazit ab. Wenn eine der beiden Suchen nichts Passendes findet oder fehlschlägt, sage ausdrücklich, welche Quelle fehlt, statt zu raten.
   - "nachfragen": Du bist dir bei etwas Wesentlichem unsicher, das die Antwort oder die spätere Einordnung des Gesagten betrifft. Stell danach direkt eine kurze, gezielte Rückfrage — keine Retrieval nötig. "Ich weiß nicht, in welchem Kontext das gespeichert ist" ist dabei NIE ein gültiger Grund — das ist niemals eine Voraussetzung für retrieve_memory, also niemals ein Grund für "nachfragen" statt "antworten".
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
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(accessToken);

  if (authError || !user) {
    return corsJson({ error: "Not authenticated" }, { status: 401 });
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const activeContext = await getConfirmedActiveContext(
    supabase,
    contextSpaceId,
    user.id,
  );

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
        instructions: buildInstructions(activeContext?.name),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            // Was semantic_vad (scores whether the user actually sounds
            // done talking, so it's less prone to firing on background
            // noise — engine, wind, the car use case from CONTEXT.md — than
            // a silence-timer). Switched to server_vad after a live session
            // showed the known OpenAI-side reliability gap: semantic_vad
            // can silently stop emitting input_audio_buffer.speech_started
            // for the rest of a session (confirmed as a widely reported
            // issue on the OpenAI developer forum, not something under our
            // control) — one bad detection then permanently kills the
            // user's ability to speak again. server_vad's fixed
            // silence_duration_ms is more prone to false triggers on
            // background noise, but it does not have that failure mode.
            // Revisit if OpenAI fixes semantic_vad's reliability.
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: true,
            },
            // Without this, conversation.item.input_audio_transcription.*
            // events never fire and the user's half of the transcript stays
            // empty (mobile's RealtimeDialogController._recordTranscript
            // listens for the .completed event). Placement confirmed via
            // the Realtime API docs for a dedicated transcription session;
            // confirmed working against a live "type": "realtime" session.
            // language: "de" pins the expected language — without it the
            // model auto-detects per utterance and occasionally mistakes
            // German speech for English, especially on short utterances.
            transcription: { model: "gpt-transcribe", language: "de" },
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
    activeContext,
    // Keeps WebRTC signaling on the same regional OpenAI API origin that
    // minted the client secret (for example the configured EU endpoint).
    realtimeUrl: `${baseUrl}/v1/realtime/calls`,
  });
}
