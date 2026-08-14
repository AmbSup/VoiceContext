"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { createEmbeddings } from "@/lib/openai";

export async function createContext(
  _state: string | undefined,
  formData: FormData,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return "Nicht angemeldet";
  }

  const name = (formData.get("name") as string)?.trim();
  if (!name) {
    return "Name ist erforderlich";
  }
  const description = (formData.get("description") as string)?.trim() || null;

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  // Embedded so Retrieval (Suche, live retrieve_memory) can find facts
  // typed only into the Beschreibung, not just actual Memory-Items — see
  // supabase/migrations/0011_context_embeddings.sql. Best-effort: a failed
  // embedding call shouldn't block creating the context itself, it just
  // stays unsearchable until a later backfill.
  let embedding: number[] | undefined;
  try {
    [embedding] = await createEmbeddings(
      [description ? `${name}: ${description}` : name],
      user.id,
    );
  } catch (error) {
    console.error("Failed to embed new context:", error);
  }

  const { error } = await supabase.from("contexts").insert({
    context_space_id: contextSpaceId,
    name,
    description,
    embedding,
  });

  if (error) {
    return error.message;
  }

  revalidatePath("/contexts");
  return undefined;
}

export async function setActiveContext(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const contextId = (formData.get("contextId") as string | null)?.trim();
  if (!contextId) return;
  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { data: context } = await supabase
    .from("contexts")
    .select("id")
    .eq("id", contextId)
    .eq("context_space_id", contextSpaceId)
    .maybeSingle();
  if (!context) return;

  const { error } = await supabase.from("active_context_preferences").upsert(
    {
      context_space_id: contextSpaceId,
      user_id: user.id,
      default_context_id: context.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "context_space_id,user_id" },
  );
  if (error) throw error;
  revalidatePath("/contexts");
}
