import type { SupabaseClient } from "@supabase/supabase-js";
import { createChatCompletion, createEmbeddings } from "./openai";

// Segmentation Engine + Memory Extraction + Context Classification, shared
// by every input path (voice, document, manual text — see CONTEXT.md
// "Segmentation Engine" and docs/implementation-plan.md Phase 5: "gleich-
// wertige Inputs zur Segmentation/Extraction-Pipeline"). Runs once per
// finished source, never live — Memory Extraction stays deliberately
// deferred so the live dialog itself is unaffected (CONTEXT.md
// "Dialogzustand").
//
// Originally lived only in api/dialog-sessions/[id]/process/route.ts;
// extracted here so the manual-text and document-upload paths don't
// duplicate ~150 lines of prompt-building/insertion logic. That route
// keeps its own dialog_sessions-specific status bookkeeping
// (processing_status/processed_at/processing_error) and calls
// runSegmentationPipeline for the actual work.

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

const SOURCE_LABELS = {
  voice: "einer beendeten Sprach-Dialog-Session (Transkript)",
  document: "einem hochgeladenen Dokument",
  manual_text: "einer manuellen Text-Eingabe",
} as const;

function buildSystemPrompt(sourceType: SegmentationSourceType): string {
  return `Du bist die Analyse-Engine einer persönlichen Wissens-App (KI Voice Context Engine). Du bekommst den vollständigen Text aus ${SOURCE_LABELS[sourceType]} sowie Referenzdaten aus der Datenbank des Nutzers. Erledige in einem Schritt:
(1) Zerlege den Text in thematisch abgeschlossene Segmente.
(2) Extrahiere aus jedem Segment einzelne Memory-Items.
(3) Prüfe für jedes neue Memory-Item, ob es einem bereits aktiven Memory-Item aus der Liste "Aktive bestehende Memory-Items" widerspricht.
(4) Schlage für jedes Memory-Item nur bei hinreichender Sicherheit eine Zuordnung zu bestehenden Kontexten vor.

Antworte ausschließlich auf Deutsch für alle Inhalte (Segment-Text, Memory-Item-Content). Halte dich strikt an das vorgegebene JSON-Schema.

Regeln:
- Segmentiere nach Thema, nicht nach Absatz oder Zeit.
- Erzeuge nur Memory-Items mit echtem Wissenswert (Fakt, Entscheidung, Aufgabe, Idee, Annahme, offene Frage, Ziel, Risiko, Person, Termin, Ergebnis, Erkenntnis). Ignoriere Small Talk und Rauschen.
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
  return `## Volltext
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

export type SegmentationSourceType = "voice" | "document" | "manual_text";

export interface RunSegmentationPipelineParams {
  supabase: SupabaseClient;
  contextSpaceId: string;
  createdBy: string;
  safetyIdentifier: string;
  sourceType: SegmentationSourceType;
  dialogSessionId?: string;
  documentId?: string;
  transcript: string;
  // User-picked target context (see web/src/app/capture) — every memory
  // item this run creates gets linked to it directly, bypassing the
  // CONTEXT_LINK_AUTO_THRESHOLD check below entirely: that threshold
  // exists to gate the *model's own guesses*, not an explicit human
  // choice, so it doesn't apply here. Classification still runs as
  // normal and may add further links to other contexts alongside this one.
  targetContextId?: string;
}

export interface RunSegmentationPipelineResult {
  segmentsCreated: number;
  memoryItemsCreated: number;
  contextLinksCreated: number;
  supersededCount: number;
}

export async function runSegmentationPipeline({
  supabase,
  contextSpaceId,
  createdBy,
  safetyIdentifier,
  sourceType,
  dialogSessionId,
  documentId,
  transcript,
  targetContextId,
}: RunSegmentationPipelineParams): Promise<RunSegmentationPipelineResult> {
  const trimmed = transcript.trim();
  if (trimmed === "") {
    return {
      segmentsCreated: 0,
      memoryItemsCreated: 0,
      contextLinksCreated: 0,
      supersededCount: 0,
    };
  }

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

  const rawContent = await createChatCompletion({
    model: EXTRACTION_MODEL,
    safetyIdentifier,
    messages: [
      { role: "system", content: buildSystemPrompt(sourceType) },
      {
        role: "user",
        content: buildUserPrompt(
          trimmed,
          (contexts ?? []) as ContextRow[],
          (activeMemoryItems ?? []) as ActiveMemoryItemRow[],
        ),
      },
    ],
    responseSchema: {
      name: "segmentation_extraction_classification",
      schema: RESPONSE_SCHEMA,
    },
  });

  const parsed: unknown = JSON.parse(rawContent);
  if (!isValidExtractionResult(parsed)) {
    throw new Error("OpenAI extraction result did not match the expected shape");
  }

  const validContextIds = new Set((contexts ?? []).map((c) => c.id as string));
  const validActiveMemoryItemIds = new Set(
    (activeMemoryItems ?? []).map((m) => m.id as string),
  );

  let segmentsCreated = 0;
  const insertedMemoryItems: { id: string; content: string }[] = [];
  const pendingContextLinks: { memory_item_id: string; context_id: string }[] = [];
  const pendingSupersedes: { oldId: string; newId: string }[] = [];

  for (const segment of parsed.segments) {
    if (segment.content.trim() === "") continue;

    const { data: segmentRow, error: segmentError } = await supabase
      .from("segments")
      .insert({
        context_space_id: contextSpaceId,
        source_type: sourceType,
        dialog_session_id: dialogSessionId ?? null,
        document_id: documentId ?? null,
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
          created_by: createdBy,
        })
        .select("id")
        .single();
      if (memoryItemError || !memoryItemRow) {
        throw new Error(`Failed to insert memory item: ${memoryItemError?.message}`);
      }
      insertedMemoryItems.push({ id: memoryItemRow.id, content: item.content });

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
            `(context space ${contextSpaceId})`,
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

      if (
        targetContextId !== undefined &&
        !pendingContextLinks.some(
          (link) =>
            link.memory_item_id === memoryItemRow.id &&
            link.context_id === targetContextId,
        )
      ) {
        pendingContextLinks.push({
          memory_item_id: memoryItemRow.id,
          context_id: targetContextId,
        });
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

  // Best-effort: embeddings power Retrieval (search) but aren't required
  // for the extraction result itself, so a failure here doesn't roll back
  // everything already inserted above — it just leaves those items
  // unsearchable by vector similarity until a later backfill.
  if (insertedMemoryItems.length > 0) {
    try {
      const embeddings = await createEmbeddings(
        insertedMemoryItems.map((item) => item.content),
        safetyIdentifier,
      );
      await Promise.all(
        insertedMemoryItems.map((item, index) =>
          supabase
            .from("memory_items")
            .update({ embedding: embeddings[index] })
            .eq("id", item.id),
        ),
      );
    } catch (error) {
      console.error(
        `Failed to generate/store embeddings for context space ${contextSpaceId}:`,
        error,
      );
    }
  }

  return {
    segmentsCreated,
    memoryItemsCreated: insertedMemoryItems.length,
    contextLinksCreated: pendingContextLinks.length,
    supersededCount: pendingSupersedes.length,
  };
}
