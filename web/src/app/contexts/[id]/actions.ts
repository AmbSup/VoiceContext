"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";

export async function deleteContextMemoryItem(
  contextId: string,
  memoryItemId: string,
): Promise<string | undefined> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";
  if (!contextId || !memoryItemId) return "Memory-Item fehlt";

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { data: item, error: itemError } = await supabase
    .from("memory_items")
    .select("id, memory_context_links!inner(context_id)")
    .eq("id", memoryItemId)
    .eq("context_space_id", contextSpaceId)
    .eq("memory_context_links.context_id", contextId)
    .maybeSingle();

  if (itemError) return itemError.message;
  if (!item) return "Memory-Item in diesem Kontext nicht gefunden";

  const { data: deleted, error: deleteError } = await supabase
    .from("memory_items")
    .delete()
    .eq("id", memoryItemId)
    .eq("context_space_id", contextSpaceId)
    .select("id")
    .maybeSingle();

  if (deleteError) return deleteError.message;
  if (!deleted) return "Memory-Item konnte nicht gelöscht werden";

  revalidatePath(`/contexts/${contextId}`);
  revalidatePath("/contexts");
  revalidatePath("/search");
  return undefined;
}
