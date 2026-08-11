"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import {
  runSegmentationPipeline,
  type RunSegmentationPipelineResult,
} from "@/lib/pipeline";

export interface CaptureState {
  error?: string;
  success?: RunSegmentationPipelineResult;
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

  try {
    const result = await runSegmentationPipeline({
      supabase,
      contextSpaceId,
      createdBy: user.id,
      safetyIdentifier: user.id,
      sourceType: "manual_text",
      transcript: text,
    });
    revalidatePath("/inbox");
    revalidatePath("/contexts");
    return { success: result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// MVP: plain-text formats only — no PDF/DOCX text extraction pipeline
// exists yet (see docs/implementation-plan.md Phase 5). The Segmentation
// Engine gets the raw text either way, so uploading a .txt export is
// functionally equivalent to any richer format for now.
const ALLOWED_EXTENSIONS = [".txt", ".md", ".markdown"];
const MAX_FILE_SIZE_BYTES = 300 * 1024;

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

  const dotIndex = file.name.lastIndexOf(".");
  const extension = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return {
      error: `Dateityp nicht unterstützt (erlaubt: ${ALLOWED_EXTENSIONS.join(", ")})`,
    };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { error: "Datei ist zu groß (max. 300 KB)" };
  }

  const text = (await file.text()).trim();
  if (!text) return { error: "Datei ist leer" };

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

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
    })
    .select("id")
    .single();
  if (documentError || !documentRow) {
    await supabase.storage.from("documents").remove([storagePath]);
    return { error: `Dokument-Eintrag fehlgeschlagen: ${documentError?.message}` };
  }

  try {
    const result = await runSegmentationPipeline({
      supabase,
      contextSpaceId,
      createdBy: user.id,
      safetyIdentifier: user.id,
      sourceType: "document",
      documentId: documentRow.id,
      transcript: text,
    });
    revalidatePath("/inbox");
    revalidatePath("/contexts");
    return { success: result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
