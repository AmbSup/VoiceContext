"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import {
  runSegmentationPipeline,
  type RunSegmentationPipelineResult,
} from "@/lib/pipeline";
import {
  DOCUMENT_FILE_LIMITS,
  MAX_EXTRACTED_TEXT_CHARACTERS,
  extensionOf,
  extractDocumentText,
  formatFileSize,
  splitDocumentText,
} from "@/lib/document-text";
import { storeDocumentChunks } from "@/lib/document-chunks";

export interface CaptureState {
  error?: string;
  success?: RunSegmentationPipelineResult;
  // Set alongside `error` when uploadDocument's chunk loop fails partway
  // through — the earlier chunks' segments/memory items are already
  // committed (each runSegmentationPipeline call is its own set of writes,
  // there's no cross-chunk rollback), so the error alone would otherwise
  // misleadingly imply nothing was saved.
  partial?: RunSegmentationPipelineResult;
}

// Free-text "Ziel-Kontext" field on both capture forms: the user types a
// name themselves rather than picking from a list (see the datalist
// suggestions in capture/page.tsx, which assist but don't constrain the
// input). Find-or-create by case-insensitive name so re-typing an
// existing context's name reuses it instead of creating a near-duplicate.
async function resolveTargetContextId(
  supabase: SupabaseClient,
  contextSpaceId: string,
  rawName: FormDataEntryValue | null,
): Promise<{ id?: string; error?: string }> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return {};

  const { data: existing, error: lookupError } = await supabase
    .from("contexts")
    .select("id")
    .eq("context_space_id", contextSpaceId)
    .ilike("name", name)
    .maybeSingle();
  if (lookupError) return { error: lookupError.message };
  if (existing) return { id: existing.id as string };

  const { data: created, error: insertError } = await supabase
    .from("contexts")
    .insert({ context_space_id: contextSpaceId, name })
    .select("id")
    .single();
  if (insertError || !created) {
    return {
      error: insertError?.message ?? "Kontext konnte nicht angelegt werden",
    };
  }
  return { id: created.id as string };
}

export async function submitManualText(
  _state: CaptureState | undefined,
  formData: FormData,
): Promise<CaptureState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nicht angemeldet" };

  const text = (formData.get("text") as string)?.trim();
  if (!text) return { error: "Text darf nicht leer sein" };
  if (text.length > 100_000) {
    return { error: "Text ist zu lang (max. 100.000 Zeichen)" };
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const targetContext = await resolveTargetContextId(
    supabase,
    contextSpaceId,
    formData.get("target_context"),
  );
  if (targetContext.error) return { error: targetContext.error };

  try {
    const result = await runSegmentationPipeline({
      supabase,
      contextSpaceId,
      createdBy: user.id,
      safetyIdentifier: user.id,
      sourceType: "manual_text",
      transcript: text,
      targetContextId: targetContext.id,
    });
    revalidatePath("/inbox");
    revalidatePath("/contexts");
    // Covers every context detail page, not just the manually typed
    // target-context — the AI's own classification can link a memory item
    // to any existing context, and revalidatePath("/contexts") alone does
    // NOT cascade to its dynamic [id] children (different cache entries).
    revalidatePath("/contexts/[id]", "page");
    return { success: result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// MVP: plain-text formats only — no PDF/DOCX text extraction pipeline
// exists yet (see docs/implementation-plan.md Phase 5). The Segmentation
// Engine gets the raw text either way, so uploading a .txt export is
// functionally equivalent to any richer format for now.
const ALLOWED_EXTENSIONS = Object.keys(DOCUMENT_FILE_LIMITS);

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function uploadDocument(
  _state: CaptureState | undefined,
  formData: FormData,
): Promise<CaptureState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nicht angemeldet" };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Bitte eine Datei auswählen" };
  }

  const extension = extensionOf(file.name);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return {
      error: `Dateityp nicht unterstützt (erlaubt: ${ALLOWED_EXTENSIONS.join(", ")})`,
    };
  }
  const fileSizeLimit = DOCUMENT_FILE_LIMITS[extension];
  if (file.size > fileSizeLimit) {
    return {
      error: `Datei ist zu groß (max. ${formatFileSize(fileSizeLimit)} für ${extension})`,
    };
  }

  let text: string;
  try {
    text = await extractDocumentText(file, extension);
  } catch (error) {
    return {
      error: `Text konnte nicht extrahiert werden: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!text) {
    return {
      error:
        extension === ".pdf"
          ? "PDF enthält keinen auslesbaren Text. Eingescannte PDFs benötigen OCR."
          : "Dokument enthält keinen auslesbaren Text",
    };
  }
  if (text.length > MAX_EXTRACTED_TEXT_CHARACTERS) {
    return {
      error: `Dokument enthält zu viel Text (max. ${MAX_EXTRACTED_TEXT_CHARACTERS.toLocaleString("de-DE")} Zeichen nach Extraktion)`,
    };
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  // Resolve/validate the requested target before creating a Storage object or
  // documents row, so an invalid context cannot leave an orphaned upload.
  const targetContext = await resolveTargetContextId(
    supabase,
    contextSpaceId,
    formData.get("target_context"),
  );
  if (targetContext.error) return { error: targetContext.error };

  // Path convention `${context_space_id}/...` matches the storage RLS
  // policy in supabase/migrations/0009_documents_storage_bucket.sql.
  const storagePath = `${contextSpaceId}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, file, { contentType: file.type || "text/plain" });
  if (uploadError) {
    return { error: `Upload fehlgeschlagen: ${uploadError.message}` };
  }

  const { data: documentRow, error: documentError } = await supabase
    .from("documents")
    .insert({
      context_space_id: contextSpaceId,
      uploaded_by: user.id,
      file_name: file.name,
      file_url: storagePath,
      context_id: targetContext.id ?? null,
    })
    .select("id")
    .single();
  if (documentError || !documentRow) {
    await supabase.storage.from("documents").remove([storagePath]);
    return {
      error: `Dokument-Eintrag fehlgeschlagen: ${documentError?.message}`,
    };
  }

  const result: RunSegmentationPipelineResult = {
    documentChunksCreated: 0,
    segmentsCreated: 0,
    memoryItemsCreated: 0,
    contextLinksCreated: 0,
    supersededCount: 0,
    flaggedForReviewCount: 0,
  };
  try {
    result.documentChunksCreated = await storeDocumentChunks({
      supabase,
      contextSpaceId,
      contextId: targetContext.id,
      documentId: documentRow.id,
      text,
      safetyIdentifier: user.id,
    });

    for (const chunk of splitDocumentText(text)) {
      const chunkResult = await runSegmentationPipeline({
        supabase,
        contextSpaceId,
        createdBy: user.id,
        safetyIdentifier: user.id,
        sourceType: "document",
        documentId: documentRow.id,
        transcript: chunk,
        targetContextId: targetContext.id,
      });
      result.segmentsCreated += chunkResult.segmentsCreated;
      result.memoryItemsCreated += chunkResult.memoryItemsCreated;
      result.contextLinksCreated += chunkResult.contextLinksCreated;
      result.supersededCount += chunkResult.supersededCount;
      result.flaggedForReviewCount += chunkResult.flaggedForReviewCount;
    }
    revalidatePath("/inbox");
    revalidatePath("/contexts");
    // Covers every context detail page, not just the manually typed
    // target-context — the AI's own classification can link a memory item
    // to any existing context, and revalidatePath("/contexts") alone does
    // NOT cascade to its dynamic [id] children (different cache entries).
    revalidatePath("/contexts/[id]", "page");
    return { success: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { data: rollback, error: rollbackError } = await supabase
      .rpc("rollback_document_import", { p_document_id: documentRow.id })
      .single<{ storage_path: string }>();

    if (rollbackError || !rollback) {
      // Do not remove the object while its documents row still exists. The
      // partial result is surfaced explicitly so an operator can retry the
      // compensating cleanup without creating a silent broken reference.
      revalidatePath("/inbox");
      revalidatePath("/contexts");
      revalidatePath("/contexts/[id]", "page");
      return {
        error: `${message} (Rollback fehlgeschlagen: ${rollbackError?.message ?? "unbekannter Fehler"})`,
        partial: result.memoryItemsCreated > 0 ? result : undefined,
      };
    }

    const { error: storageCleanupError } = await supabase.storage
      .from("documents")
      .remove([rollback.storage_path]);
    if (storageCleanupError) {
      return {
        error: `${message} (Daten wurden zurückgerollt, Datei-Cleanup fehlgeschlagen: ${storageCleanupError.message})`,
      };
    }
    return { error: `${message} (Import vollständig zurückgerollt)` };
  }
}
