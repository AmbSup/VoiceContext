import type { SupabaseClient } from "@supabase/supabase-js";
import { createChatCompletion, createEmbeddings } from "./openai";
import { truncateToTokens } from "./token-count";

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
//
// Two-stage design (see docs/implementation-plan.md roadmap:
// "Extraktionspipeline entlasten" — step 2 after Hybrid Retrieval). The
// original single-shot design loaded every active Memory-Item of the
// Context Space into the extraction prompt so the model could spot
// contradictions inline (ADR 0002) — that scales with total memory, not
// with what actually changed. Now:
//   Stage 1 — segment the source and extract new Memory-Items, with NO
//   existing-item context in the prompt at all (contexts stay, since those
//   are small/low-cardinality, not the thing that scaled unboundedly).
//   Stage 2 — for each newly inserted item, retrieve a handful (~8) of
//   status='aktiv' conflict candidates via Hybrid Retrieval
//   (match_conflict_candidates, supabase/migrations/0014_conflict_review.sql)
//   and classify them in one bundled LLM call. High-confidence
//   duplicate/supersede verdicts apply directly; everything else becomes a
//   memory_conflict_reviews row for manual confirmation on /inbox.

const EXTRACTION_MODEL = "gpt-4.1-mini";

const MEMORY_ITEM_TYPES = [
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
] as const;
const CONFIDENCE_LEVELS = ["niedrig", "mittel", "hoch"] as const;

// Enforced in code, not just prompted: CONTEXT.md's Inbox guarantee ("nie
// eine automatische Zuordnung durch die Classification Engine" bei
// Unsicherheit) must hold even if the model doesn't follow instructions.
const CONTEXT_LINK_AUTO_THRESHOLD: ConfidenceLevel = "hoch";

// How many status='aktiv' candidates to retrieve per new item for conflict
// classification — a handful, not the whole active set (that's the entire
// point of this rewrite). Retrieval itself runs with limited concurrency
// (no p-limit/p-queue in web/package.json, hence the small local helper
// below) so a large batch of new items doesn't fire dozens of simultaneous
// RPC calls.
const CONFLICT_CANDIDATE_COUNT = 8;
const CONFLICT_CANDIDATE_CONCURRENCY = 5;

const CONFLICT_VERDICTS = [
  "kein_konflikt",
  "duplikat",
  "widerspruch",
  "ersetzt_veraltet",
] as const;
// "duplikat" and "ersetzt_veraltet" auto-apply at hoch confidence (both
// mean the existing item is now redundant — a very-confident duplicate is
// treated the same as a clean replacement, confirmed with the user).
// "widerspruch" never auto-applies at any confidence: the model being sure
// two items contradict each other doesn't tell us which one is actually
// current, so that always needs a human call — see
// supabase/migrations/0014_conflict_review.sql.
const AUTO_APPLY_VERDICTS = new Set<ConflictVerdictType>([
  "duplikat",
  "ersetzt_veraltet",
]);

type MemoryItemType = (typeof MEMORY_ITEM_TYPES)[number];
type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
type ConflictVerdictType = (typeof CONFLICT_VERDICTS)[number];

interface ExtractedContextLink {
  context_id: string;
  confidence: ConfidenceLevel;
}

interface ExtractedMemoryItem {
  type: MemoryItemType;
  content: string;
  confidence: ConfidenceLevel;
  context_links: ExtractedContextLink[];
  // True only for an explicit Merk-/Aufgaben-Anweisung ("merk dir das",
  // "das ist ein offener Punkt") — independent of `confidence`, which is
  // about extraction certainty, not provenance. Powers the Ergebnisse
  // screen's distinction between user-directed and passively-extracted
  // items (mobile/lib/features/dialog_results).
  user_directed: boolean;
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
                user_directed: { type: "boolean" },
              },
              required: [
                "type",
                "content",
                "confidence",
                "context_links",
                "user_directed",
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

interface ConflictClassificationCandidate {
  id: string;
  type: string;
  content: string;
  occurred_at: string;
}

interface ConflictClassificationInput {
  new_item_id: string;
  type: string;
  content: string;
  candidates: ConflictClassificationCandidate[];
}

interface ConflictVerdictResult {
  new_item_id: string;
  verdict: ConflictVerdictType;
  related_existing_item_id: string | null;
  confidence: ConfidenceLevel;
}

interface ConflictClassificationResult {
  verdicts: ConflictVerdictResult[];
}

const CONFLICT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          new_item_id: { type: "string" },
          verdict: { type: "string", enum: CONFLICT_VERDICTS },
          related_existing_item_id: { type: ["string", "null"] },
          confidence: { type: "string", enum: CONFIDENCE_LEVELS },
        },
        required: [
          "new_item_id",
          "verdict",
          "related_existing_item_id",
          "confidence",
        ],
      },
    },
  },
  required: ["verdicts"],
};

interface ContextRow {
  id: string;
  name: string;
  description: string | null;
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
(3) Schlage für jedes Memory-Item nur bei hinreichender Sicherheit eine Zuordnung zu bestehenden Kontexten vor.

Antworte ausschließlich auf Deutsch für alle Inhalte (Segment-Text, Memory-Item-Content). Halte dich strikt an das vorgegebene JSON-Schema.

Regeln:
- Segmentiere nach Thema, nicht nach Absatz oder Zeit.
- Erzeuge nur Memory-Items mit echtem Wissenswert (Fakt, Entscheidung, Aufgabe, Idee, Annahme, offene Frage, Ziel, Risiko, Person, Termin, Ergebnis, Erkenntnis). Ignoriere Small Talk und Rauschen.
- confidence beschreibt deine Sicherheit bei Inhalt und Typ des Items.
- user_directed=true setzt du AUSSCHLIESSLICH bei einer ausdrücklichen Merk-/Aufgaben-Anweisung des Nutzers (z. B. "merk dir das", "notier das als offenen Punkt", "das ist eine Aufgabe für mich", "schick mir das"). Sonst immer false — auch wenn du dir beim Inhalt sehr sicher bist. Das ist unabhängig von confidence: confidence bewertet, wie sicher du beim Inhalt/Typ bist, user_directed bewertet nur, ob der Nutzer selbst ausdrücklich dazu aufgefordert hat.
- Kontext-Zuordnung: Schlage einen Eintrag in context_links nur vor, wenn du dir sicher bist, welchem bestehenden Kontext (aus "Bestehende Kontexte") das Item zuzuordnen ist. Gib pro Vorschlag eine eigene confidence an. Im Zweifel: keinen Eintrag hinzufügen (das Item bleibt dann unzugeordnet = Inbox) — rate nicht.
- Keine leeren Segmente, keine inhaltsleeren Memory-Items.`;
}

function buildUserPrompt(transcript: string, contexts: ContextRow[]): string {
  return `## Volltext
${transcript}

## Bestehende Kontexte in dieser Context Space
${JSON.stringify(contexts)}`;
}

function buildConflictSystemPrompt(): string {
  return `Du prüfst neu extrahierte Memory-Items gegen wenige, bereits als potenziell verwandt gefundene AKTIVE bestehende Memory-Items aus derselben Context Space. Für jedes neue Item entscheidest du, ob es in einer besonderen Beziehung zu genau einem der für dieses Item gelisteten bestehenden Items steht.

Antworte für JEDES neue Item (per new_item_id, jede id aus der Eingabe genau einmal) mit:
- verdict:
  - "kein_konflikt": keine besondere Beziehung zu einem der für dieses Item gelisteten Kandidaten.
  - "duplikat": inhaltlich (nahezu) dieselbe Information wie ein bestehendes Item.
  - "widerspruch": widerspricht einem bestehenden Item inhaltlich, es ist aber NICHT klar, welches der beiden aktuell/richtig ist.
  - "ersetzt_veraltet": ersetzt ein bestehendes Item eindeutig (z. B. eine neuere Entscheidung, ein aktualisierter Termin, ein neuer Fakt, der einen alten ablöst).
- related_existing_item_id: die id des betroffenen bestehenden Items — MUSS aus der Kandidatenliste GENAU DIESES neuen Items stammen, nie erfunden und nie aus der Kandidatenliste eines anderen Items. Bei "kein_konflikt" immer null.
- confidence: deine Sicherheit bei dieser Einschätzung.`;
}

function buildConflictUserPrompt(items: ConflictClassificationInput[]): string {
  return `## Neue Memory-Items mit ihren Kandidaten\n${JSON.stringify(items)}`;
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
        Array.isArray(candidate.context_links) &&
        typeof candidate.user_directed === "boolean"
      );
    });
  });
}

function isValidConflictResult(
  value: unknown,
): value is ConflictClassificationResult {
  if (typeof value !== "object" || value === null) return false;
  const verdicts = (value as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) return false;
  return verdicts.every((v) => {
    if (typeof v !== "object" || v === null) return false;
    const candidate = v as Record<string, unknown>;
    return (
      typeof candidate.new_item_id === "string" &&
      typeof candidate.verdict === "string" &&
      CONFLICT_VERDICTS.includes(candidate.verdict as ConflictVerdictType) &&
      (candidate.related_existing_item_id === null ||
        typeof candidate.related_existing_item_id === "string") &&
      typeof candidate.confidence === "string" &&
      CONFIDENCE_LEVELS.includes(candidate.confidence as ConfidenceLevel)
    );
  });
}

// Runs `fn` over `items` with at most `limit` calls in flight at once —
// there's no p-limit/p-queue dependency in web/package.json, and this is
// the only place in the codebase that needs bounded parallelism so far.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

async function fetchConflictCandidates(
  supabase: SupabaseClient,
  contextSpaceId: string,
  item: { id: string; content: string; embedding: number[] | null },
  excludeIds: Set<string>,
): Promise<ConflictClassificationCandidate[]> {
  const { data, error } = await supabase.rpc("match_conflict_candidates", {
    query_embedding: item.embedding,
    query_text: item.content,
    match_context_space_id: contextSpaceId,
    match_count: CONFLICT_CANDIDATE_COUNT,
  });
  if (error) {
    // A retrieval failure for one item just means that item doesn't get
    // conflict-checked this run — never a reason to touch existing data.
    console.error(
      `Conflict-candidate retrieval failed for memory item ${item.id} ` +
        `(context space ${contextSpaceId}):`,
      error.message,
    );
    return [];
  }
  // Excludes sibling items from this same batch — they're brand new, not
  // "existing" conflict candidates, even though they're already status
  // 'aktiv' by the time this query runs.
  return ((data ?? []) as ConflictClassificationCandidate[]).filter(
    (c) => !excludeIds.has(c.id),
  );
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
  documentChunksCreated?: number;
  segmentsCreated: number;
  memoryItemsCreated: number;
  contextLinksCreated: number;
  supersededCount: number;
  // New items whose conflict verdict wasn't confident enough to apply
  // automatically — see memory_conflict_reviews / the "Mögliche Konflikte"
  // section on /inbox.
  flaggedForReviewCount: number;
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
      flaggedForReviewCount: 0,
    };
  }

  const { data: contexts } = await supabase
    .from("contexts")
    .select("id, name, description")
    .eq("context_space_id", contextSpaceId);

  const rawContent = await createChatCompletion({
    model: EXTRACTION_MODEL,
    safetyIdentifier,
    messages: [
      { role: "system", content: buildSystemPrompt(sourceType) },
      {
        role: "user",
        content: buildUserPrompt(trimmed, (contexts ?? []) as ContextRow[]),
      },
    ],
    responseSchema: {
      name: "segmentation_extraction_classification",
      schema: RESPONSE_SCHEMA,
    },
  });

  const parsed: unknown = JSON.parse(rawContent);
  if (!isValidExtractionResult(parsed)) {
    throw new Error(
      "OpenAI extraction result did not match the expected shape",
    );
  }

  const validContextIds = new Set((contexts ?? []).map((c) => c.id as string));

  let segmentsCreated = 0;
  const insertedSegments: { id: string; content: string }[] = [];
  const insertedMemoryItems: {
    id: string;
    type: MemoryItemType;
    content: string;
  }[] = [];
  const pendingContextLinks: { memory_item_id: string; context_id: string }[] =
    [];

  for (const segment of parsed.segments) {
    if (segment.content.trim() === "") continue;

    const { data: segmentRow, error: segmentError } = await supabase
      .from("segments")
      .insert({
        context_space_id: contextSpaceId,
        source_type: sourceType,
        dialog_session_id: dialogSessionId ?? null,
        document_id: documentId ?? null,
        context_id: targetContextId ?? null,
        content: segment.content,
      })
      .select("id")
      .single();
    if (segmentError || !segmentRow) {
      throw new Error(`Failed to insert segment: ${segmentError?.message}`);
    }
    segmentsCreated += 1;
    insertedSegments.push({ id: segmentRow.id, content: segment.content });

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
          user_directed: item.user_directed,
        })
        .select("id")
        .single();
      if (memoryItemError || !memoryItemRow) {
        throw new Error(
          `Failed to insert memory item: ${memoryItemError?.message}`,
        );
      }
      insertedMemoryItems.push({
        id: memoryItemRow.id,
        type: item.type,
        content: item.content,
      });

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

  // Batched on purpose (one createEmbeddings call for every new item, not
  // one per item) — powers both Retrieval (search) and, from here on, the
  // conflict-candidate lookup below. Still best-effort: a failure leaves
  // items unsearchable/unconflict-checked until a later backfill rather
  // than rolling back the inserts above.
  let itemEmbeddings: (number[] | null)[] = insertedMemoryItems.map(() => null);
  if (insertedMemoryItems.length > 0) {
    try {
      const embeddings = await createEmbeddings(
        insertedMemoryItems.map((item) => item.content),
        safetyIdentifier,
      );
      itemEmbeddings = embeddings;
      const updateResults = await Promise.all(
        insertedMemoryItems.map((item, index) =>
          supabase
            .from("memory_items")
            .update({ embedding: embeddings[index] })
            .eq("id", item.id),
        ),
      );
      const updateError = updateResults.find((result) => result.error)?.error;
      if (updateError) {
        throw new Error(`Failed to store memory-item embedding: ${updateError.message}`);
      }
    } catch (error) {
      console.error(
        `Failed to generate/store embeddings for context space ${contextSpaceId}:`,
        error,
      );
    }
  }

  // Same best-effort batching as the memory-item embeddings above — powers
  // segments' new Hybrid Retrieval source (match_segments, see
  // 20260814150000_segment_embeddings.sql). A failure here must not roll
  // back the segments/memory_items already inserted; those rows just stay
  // unsearchable via match_segments until a later backfill.
  if (insertedSegments.length > 0) {
    try {
      const segmentEmbeddings = await createEmbeddings(
        insertedSegments.map((s) => truncateToTokens(s.content, 7_000)),
        safetyIdentifier,
      );
      if (segmentEmbeddings.length !== insertedSegments.length) {
        throw new Error(
          `Segment embedding count mismatch: expected ${insertedSegments.length}, got ${segmentEmbeddings.length}`,
        );
      }
      const updateResults = await Promise.all(
        insertedSegments.map((s, index) =>
          supabase
            .from("segments")
            .update({ embedding: segmentEmbeddings[index] })
            .eq("id", s.id),
          ),
      );
      const updateError = updateResults.find((result) => result.error)?.error;
      if (updateError) {
        throw new Error(`Failed to store segment embedding: ${updateError.message}`);
      }
    } catch (error) {
      console.error(
        `Failed to generate/store segment embeddings for context space ${contextSpaceId}:`,
        error,
      );
    }
  }

  let supersededCount = 0;
  let flaggedForReviewCount = 0;

  if (insertedMemoryItems.length > 0) {
    const newItemIds = new Set(insertedMemoryItems.map((item) => item.id));

    const candidatesPerItem = await mapWithConcurrency(
      insertedMemoryItems.map((item, index) => ({
        item,
        embedding: itemEmbeddings[index] ?? null,
      })),
      CONFLICT_CANDIDATE_CONCURRENCY,
      async ({ item, embedding }) => ({
        item,
        candidates: await fetchConflictCandidates(
          supabase,
          contextSpaceId,
          { id: item.id, content: item.content, embedding },
          newItemIds,
        ),
      }),
    );

    const classificationInputs: ConflictClassificationInput[] =
      candidatesPerItem
        .filter(({ candidates }) => candidates.length > 0)
        .map(({ item, candidates }) => ({
          new_item_id: item.id,
          type: item.type,
          content: item.content,
          candidates,
        }));

    if (classificationInputs.length > 0) {
      const candidateIdsByNewItem = new Map(
        classificationInputs.map((input) => [
          input.new_item_id,
          new Set(input.candidates.map((c) => c.id)),
        ]),
      );

      try {
        const rawVerdicts = await createChatCompletion({
          model: EXTRACTION_MODEL,
          safetyIdentifier,
          messages: [
            { role: "system", content: buildConflictSystemPrompt() },
            {
              role: "user",
              content: buildConflictUserPrompt(classificationInputs),
            },
          ],
          responseSchema: {
            name: "conflict_classification",
            schema: CONFLICT_RESPONSE_SCHEMA,
          },
        });
        const parsedVerdicts: unknown = JSON.parse(rawVerdicts);
        if (!isValidConflictResult(parsedVerdicts)) {
          throw new Error(
            "OpenAI conflict classification result did not match the expected shape",
          );
        }

        // Structured output constrains each object, but cannot express the
        // cross-row invariant "every requested new_item_id exactly once".
        // Validate the complete set before applying any verdict so a missing,
        // duplicate or invented id cannot partially process this batch.
        const expectedNewItemIds = new Set(
          classificationInputs.map((input) => input.new_item_id),
        );
        const seenNewItemIds = new Set<string>();
        if (parsedVerdicts.verdicts.length !== expectedNewItemIds.size) {
          throw new Error(
            "Conflict classification did not return exactly one verdict per item",
          );
        }
        for (const verdict of parsedVerdicts.verdicts) {
          if (
            !expectedNewItemIds.has(verdict.new_item_id) ||
            seenNewItemIds.has(verdict.new_item_id)
          ) {
            throw new Error(
              `Conflict classification returned an unknown or duplicate new_item_id: ${verdict.new_item_id}`,
            );
          }
          seenNewItemIds.add(verdict.new_item_id);
        }

        for (const verdict of parsedVerdicts.verdicts) {
          const candidateIds = candidateIdsByNewItem.get(verdict.new_item_id);
          const relationIsValid =
            verdict.verdict === "kein_konflikt"
              ? verdict.related_existing_item_id === null
              : verdict.related_existing_item_id !== null &&
                candidateIds?.has(verdict.related_existing_item_id) === true;
          if (!relationIsValid) {
            throw new Error(
              `Conflict classification returned an invalid related item for ${verdict.new_item_id}`,
            );
          }
        }

        for (const verdict of parsedVerdicts.verdicts) {
          if (verdict.verdict === "kein_konflikt") continue;

          const candidateIds = candidateIdsByNewItem.get(verdict.new_item_id);
          if (
            !candidateIds ||
            verdict.related_existing_item_id === null ||
            !candidateIds.has(verdict.related_existing_item_id)
          ) {
            console.warn(
              `Ignoring conflict verdict for memory item ${verdict.new_item_id} ` +
                `referencing unknown related_existing_item_id ` +
                `${verdict.related_existing_item_id} (context space ${contextSpaceId})`,
            );
            continue;
          }

          if (
            AUTO_APPLY_VERDICTS.has(verdict.verdict) &&
            verdict.confidence === "hoch"
          ) {
            const { data: superseded, error } = await supabase
              .from("memory_items")
              .update({
                status: "ueberholt",
                superseded_by_id: verdict.new_item_id,
              })
              .eq("id", verdict.related_existing_item_id)
              .eq("status", "aktiv")
              .select("id")
              .maybeSingle();
            if (error) {
              console.error(
                `Failed to auto-supersede memory item ${verdict.related_existing_item_id}:`,
                error.message,
              );
            } else if (superseded) {
              supersededCount += 1;
            } else {
              console.warn(
                `Conflict candidate ${verdict.related_existing_item_id} was no longer active`,
              );
            }
          } else {
            const { error: reviewError } = await supabase.rpc(
              "flag_memory_conflict_review",
              {
                p_context_space_id: contextSpaceId,
                p_new_memory_item_id: verdict.new_item_id,
                p_existing_memory_item_id: verdict.related_existing_item_id,
                p_verdict: verdict.verdict,
                p_confidence: verdict.confidence,
              },
            );
            if (reviewError) {
              console.error(
                `Failed to record conflict review for memory item ${verdict.new_item_id}:`,
                reviewError.message,
              );
            } else {
              flaggedForReviewCount += 1;
            }
          }
        }
      } catch (error) {
        // Never partially apply guesses on a classifier failure: no
        // supersedes, no review rows for this run. The new items
        // themselves are already safely inserted as 'aktiv' — only
        // conflict resolution for them didn't happen this time.
        console.error(
          `Conflict classification failed for context space ${contextSpaceId}:`,
          error,
        );
      }
    }
  }

  return {
    segmentsCreated,
    memoryItemsCreated: insertedMemoryItems.length,
    contextLinksCreated: pendingContextLinks.length,
    supersededCount,
    flaggedForReviewCount,
  };
}
