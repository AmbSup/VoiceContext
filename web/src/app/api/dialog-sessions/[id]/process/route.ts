import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

// Post-hoc Segmentation Engine + Memory Extraction + Context Classification
// for a finished Dialog-Session (see docs/implementation-plan.md Phase 2,
// steps 4-6, and ADR 0002). Runs once per dialog_sessions row, triggered by
// the mobile app right after it persists ended_at/full_transcript (see
// mobile/lib/core/api/dialog_processing_client.dart). Never runs live —
// Memory Extraction stays deliberately deferred so the Realtime dialog
// itself is unaffected (CONTEXT.md "Dialogzustand").
//
// Auth follows the same cross-origin pattern as
// web/src/app/api/realtime-token/route.ts: the mobile client forwards its
// own Supabase access token, and all reads/writes below run through that
// same anon-key client so RLS enforces context_space membership naturally
// — no service-role client involved.

const EXTRACTION_MODEL = "gpt-4.1-mini";

const MEMORY_ITEM_TYPES = [
  "fakt", "entscheidung", "aufgabe", "idee", "annahme", "offene_frage",
  "ziel", "risiko", "person", "termin", "ergebnis", "erkenntnis",
] as const;
const CONFIDENCE_LEVELS = ["niedrig", "mittel", "hoch"] as const;

// Enforced in code, not just prompted: CONTEXT.md's Inbox guarantee ("nie
// eine automatische Zuordnung durch die Classification Engine" bei
// Unsicherheit) must hold even if the model doesn't follow instructions.
const CONTEXT_LINK_AUTO_THRESHOLD: ConfidenceLevel = "hoch";

type MemoryItemType = (typeof MEMORY_ITEM_TYPES)[number];
type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

interface ExtractedContextLink {
  context_id: string;
  confidence: ConfidenceLevel;
}

interface ExtractedMemoryItem {
  type: MemoryItemType;
  content: string;
  confidence: ConfidenceLevel;
  contradicts_existing_memory_item_id: string | null;
  context_links: ExtractedContextLink[];
}

interface ExtractedSegment {
  content: string;
  memory_items: ExtractedMemoryItem[];
}

interface ExtractionResult {
  segments: ExtractedSegment[];
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          memory_items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: MEMORY_ITEM_TYPES },
                content: { type: "string" },
                confidence: { type: "string", enum: CONFIDENCE_LEVELS },
                contradicts_existing_memory_item_id: {
                  type: ["string", "null"],
                },
                context_links: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      context_id: { type: "string" },
                      confidence: { type: "string", enum: CONFIDENCE_LEVELS },
                    },
                    required: ["context_id", "confidence"],
                  },
                },
              },
              required: [
                "type",
                "content",
                "confidence",
                "contradicts_existing_memory_item_id",
                "context_links",
              ],
            },
          },
        },
        required: ["content", "memory_items"],
      },
    },
  },
  required: ["segments"],
};

interface ContextRow {
  id: string;
  name: string;
  description: string | null;
}

interface ActiveMemoryItemRow {
  id: string;
  type: string;
  content: string;
  memory_context_links: { context_id: string }[];
}

function buildSystemPrompt(): string {
  return `Du bist die Analyse-Engine einer persönlichen Wissens-App (KI Voice Context Engine). Du bekommst das vollständige Transkript einer beendeten Sprach-Dialog-Session sowie Referenzdaten aus der Datenbank des Nutzers. Erledige in einem Schritt:
(1) Zerlege das Transkript in thematisch abgeschlossene Segmente.
(2) Extrahiere aus jedem Segment einzelne Memory-Items.
(3) Prüfe für jedes neue Memory-Item, ob es einem bereits aktiven Memory-Item aus der Liste "Aktive bestehende Memory-Items" widerspricht.
(4) Schlage für jedes Memory-Item nur bei hinreichender Sicherheit eine Zuordnung zu bestehenden Kontexten vor.

Antworte ausschließlich auf Deutsch für alle Inhalte (Segment-Text, Memory-Item-Content). Halte dich strikt an das vorgegebene JSON-Schema.

Regeln:
- Segmentiere nach Thema, nicht nach Sprecherwechsel oder Zeit.
- Erzeuge nur Memory-Items mit echtem Wissenswert (Fakt, Entscheidung, Aufgabe, Idee, Annahme, offene Frage, Ziel, Risiko, Person, Termin, Ergebnis, Erkenntnis). Ignoriere Small Talk und Transkriptionsrauschen.
- confidence beschreibt deine Sicherheit bei Inhalt und Typ des Items.
- Widerspruchs-Check: Nutze ausschließlich IDs aus der Liste "Aktive bestehende Memory-Items" für contradicts_existing_memory_item_id, nie erfundene IDs. Flagge einen Widerspruch nur, wenn das neue Item inhaltlich im selben Themenbereich liegt wie das bestehende und ihm widerspricht (z. B. eine neue Entscheidung ersetzt eine alte, ein neuer Fakt widerlegt einen alten). Sonst null.
- Kontext-Zuordnung: Schlage einen Eintrag in context_links nur vor, wenn du dir sicher bist, welchem bestehenden Kontext (aus "Bestehende Kontexte") das Item zuzuordnen ist. Gib pro Vorschlag eine eigene confidence an. Im Zweifel: keinen Eintrag hinzufügen (das Item bleibt dann unzugeordnet = Inbox) — rate nicht.
- Keine leeren Segmente, keine inhaltsleeren Memory-Items.`;
}

function buildUserPrompt(
  transcript: string,
  contexts: ContextRow[],
  activeMemoryItems: ActiveMemoryItemRow[],
): string {
  return `## Transkript der Dialog-Session
${transcript}

## Bestehende Kontexte in dieser Context Space
${JSON.stringify(contexts)}

## Aktive bestehende Memory-Items in dieser Context Space (für Widerspruchs-Check)
${JSON.stringify(activeMemoryItems)}`;
}

function isValidExtractionResult(value: unknown): value is ExtractionResult {
  if (typeof value !== "object" || value === null) return false;
  const segments = (value as { segments?: unknown }).segments;
  if (!Array.isArray(segments)) return false;
  return segments.every((segment) => {
    if (typeof segment !== "object" || segment === null) return false;
    const { content, memory_items: memoryItems } = segment as {
      content?: unknown;
      memory_items?: unknown;
    };
    if (typeof content !== "string" || !Array.isArray(memoryItems)) {
      return false;
    }
    return memoryItems.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as Record<string, unknown>;
      return (
        typeof candidate.type === "string" &&
        typeof candidate.content === "string" &&
        typeof candidate.confidence === "string" &&
        (candidate.contradicts_existing_memory_item_id === null ||
          typeof candidate.contradicts_existing_memory_item_id === "string") &&
        Array.isArray(candidate.context_links)
      );
    });
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const accessToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");

  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Passing the user's JWT as the client's Authorization header (not just
  // to auth.getUser() below) is what makes the .from() calls further down
  // run as the `authenticated` role under RLS — auth.getUser(accessToken)
  // only verifies the token, it doesn't attach it to the client's own
  // outgoing requests.
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
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id: dialogSessionId } = await params;

  const { data: session } = await supabase
    .from("dialog_sessions")
    .select("id, context_space_id, ended_at, full_transcript, processing_status")
    .eq("id", dialogSessionId)
    .single();

  // RLS already scopes this to rows the caller's context_space membership
  // covers, so a missing row means "not found or not yours" — either way
  // there's nothing more to say than 404.
  if (!session) {
    return NextResponse.json({ error: "Dialog session not found" }, { status: 404 });
  }
  if (!session.ended_at) {
    return NextResponse.json(
      { error: "Dialog session has not ended yet" },
      { status: 409 },
    );
  }
  if (session.processing_status === "fertig") {
    return NextResponse.json({ status: "already_processed" });
  }
  if (session.processing_status === "laeuft") {
    return NextResponse.json(
      { error: "Dialog session is already being processed" },
      { status: 409 },
    );
  }

  const transcript = (session.full_transcript ?? "").trim();
  if (transcript === "") {
    await supabase
      .from("dialog_sessions")
      .update({ processing_status: "fertig", processed_at: new Date().toISOString() })
      .eq("id", dialogSessionId);
    return NextResponse.json({
      segmentsCreated: 0,
      memoryItemsCreated: 0,
      contextLinksCreated: 0,
      supersededCount: 0,
    });
  }

  // Closes the race window before the (slow) OpenAI call so a concurrent
  // call to this route sees 'laeuft' instead of racing the same session.
  await supabase
    .from("dialog_sessions")
    .update({ processing_status: "laeuft" })
    .eq("id", dialogSessionId);

  try {
    const contextSpaceId = session.context_space_id as string;

    const [{ data: contexts }, { data: activeMemoryItems }] = await Promise.all([
      supabase
        .from("contexts")
        .select("id, name, description")
        .eq("context_space_id", contextSpaceId),
      supabase
        .from("memory_items")
        .select("id, type, content, memory_context_links(context_id)")
        .eq("context_space_id", contextSpaceId)
        .eq("status", "aktiv"),
    ]);

    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com";
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const openaiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": user.id,
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content: buildUserPrompt(
              transcript,
              (contexts ?? []) as ContextRow[],
              (activeMemoryItems ?? []) as ActiveMemoryItemRow[],
            ),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "segmentation_extraction_classification",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      }),
    });

    if (!openaiResponse.ok) {
      throw new Error(
        `OpenAI request failed (${openaiResponse.status}): ${await openaiResponse.text()}`,
      );
    }

    const completion = await openaiResponse.json();
    const rawContent = completion.choices?.[0]?.message?.content;
    if (typeof rawContent !== "string" || rawContent.trim() === "") {
      throw new Error("OpenAI returned no extraction content");
    }

    const parsed: unknown = JSON.parse(rawContent);
    if (!isValidExtractionResult(parsed)) {
      throw new Error("OpenAI extraction result did not match the expected shape");
    }

    const validContextIds = new Set((contexts ?? []).map((c) => c.id as string));
    const validActiveMemoryItemIds = new Set(
      (activeMemoryItems ?? []).map((m) => m.id as string),
    );

    let segmentsCreated = 0;
    let memoryItemsCreated = 0;
    const pendingContextLinks: { memory_item_id: string; context_id: string }[] = [];
    const pendingSupersedes: { oldId: string; newId: string }[] = [];

    for (const segment of parsed.segments) {
      if (segment.content.trim() === "") continue;

      const { data: segmentRow, error: segmentError } = await supabase
        .from("segments")
        .insert({
          context_space_id: contextSpaceId,
          source_type: "voice",
          dialog_session_id: dialogSessionId,
          content: segment.content,
        })
        .select("id")
        .single();
      if (segmentError || !segmentRow) {
        throw new Error(`Failed to insert segment: ${segmentError?.message}`);
      }
      segmentsCreated += 1;

      for (const item of segment.memory_items) {
        if (item.content.trim() === "") continue;

        const { data: memoryItemRow, error: memoryItemError } = await supabase
          .from("memory_items")
          .insert({
            context_space_id: contextSpaceId,
            segment_id: segmentRow.id,
            type: item.type,
            content: item.content,
            confidence: item.confidence,
            created_by: user.id,
          })
          .select("id")
          .single();
        if (memoryItemError || !memoryItemRow) {
          throw new Error(`Failed to insert memory item: ${memoryItemError?.message}`);
        }
        memoryItemsCreated += 1;

        if (
          item.contradicts_existing_memory_item_id !== null &&
          validActiveMemoryItemIds.has(item.contradicts_existing_memory_item_id)
        ) {
          pendingSupersedes.push({
            oldId: item.contradicts_existing_memory_item_id,
            newId: memoryItemRow.id,
          });
        } else if (item.contradicts_existing_memory_item_id !== null) {
          console.warn(
            `Ignoring contradicts_existing_memory_item_id referencing unknown ` +
              `memory item ${item.contradicts_existing_memory_item_id} ` +
              `(dialog session ${dialogSessionId})`,
          );
        }

        for (const link of item.context_links) {
          if (
            link.confidence === CONTEXT_LINK_AUTO_THRESHOLD &&
            validContextIds.has(link.context_id)
          ) {
            pendingContextLinks.push({
              memory_item_id: memoryItemRow.id,
              context_id: link.context_id,
            });
          }
        }
      }
    }

    if (pendingContextLinks.length > 0) {
      const { error: linksError } = await supabase
        .from("memory_context_links")
        .insert(pendingContextLinks);
      if (linksError) {
        throw new Error(`Failed to insert context links: ${linksError.message}`);
      }
    }

    for (const { oldId, newId } of pendingSupersedes) {
      await supabase
        .from("memory_items")
        .update({ status: "ueberholt", superseded_by_id: newId })
        .eq("id", oldId)
        .eq("status", "aktiv");
    }

    await supabase
      .from("dialog_sessions")
      .update({ processing_status: "fertig", processed_at: new Date().toISOString() })
      .eq("id", dialogSessionId);

    return NextResponse.json({
      segmentsCreated,
      memoryItemsCreated,
      contextLinksCreated: pendingContextLinks.length,
      supersededCount: pendingSupersedes.length,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await supabase
      .from("dialog_sessions")
      .update({
        processing_status: "fehlgeschlagen",
        processing_error: detail.slice(0, 2000),
      })
      .eq("id", dialogSessionId);
    return NextResponse.json(
      { error: "Failed to process dialog session", detail },
      { status: 502 },
    );
  }
}
