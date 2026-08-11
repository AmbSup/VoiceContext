"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";

// Only action the Inbox exposes: manual assignment to a context, chosen by
// the user themselves. Never wired to any automatic classification — see
// CONTEXT.md "Inbox".
export async function assignToContext(
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

  const memoryItemId = formData.get("memory_item_id") as string;
  const contextId = formData.get("context_id") as string;
  if (!memoryItemId || !contextId) {
    return "Kontext ist erforderlich";
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  // Defense in depth: memory_context_links RLS only checks that
  // memory_item_id belongs to a space the caller is a member of, not that
  // context_id belongs to the *same* space as the item — so confirm that
  // here rather than relying on the FK alone.
  const { data: context } = await supabase
    .from("contexts")
    .select("id")
    .eq("id", contextId)
    .eq("context_space_id", contextSpaceId)
    .single();
  if (!context) {
    return "Kontext nicht gefunden";
  }

  const { error } = await supabase.from("memory_context_links").insert({
    memory_item_id: memoryItemId,
    context_id: contextId,
  });

  if (error) {
    return error.message;
  }

  revalidatePath("/inbox");
  revalidatePath(`/contexts/${contextId}`);
  return undefined;
}
